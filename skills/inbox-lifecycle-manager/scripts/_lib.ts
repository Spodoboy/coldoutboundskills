/**
 * Shared utilities for inbox-lifecycle-manager scripts.
 *
 * READ-ONLY helpers. Nothing in this file writes to Smartlead.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export const API_BASE = "https://server.smartlead.ai/api/v1";
export const API_KEY = process.env.SMARTLEAD_API_KEY;

if (!API_KEY) {
  console.error("Missing env var: SMARTLEAD_API_KEY");
  process.exit(1);
}

// Smartlead 403s some default HTTP clients. A browser UA is the reliable path.
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function parseFlag(args: string[], flag: string, def?: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`${flag}=`));
  return arg ? arg.split("=").slice(1).join("=") : def;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export async function fetchJson(url: string, options: RequestInit = {}): Promise<any> {
  const opts: RequestInit = {
    ...options,
    headers: { "User-Agent": UA, ...(options.headers ?? {}) },
  };
  // Smartlead rate limits are account-wide, so other jobs on the same key eat into the
  // budget. Measured on a ~20k-inbox account: Retry-After said 60s while the key stayed
  // refused for 8+ minutes. So grow the wait past Retry-After (max of the two), cap at 5 min.
  const MAX = 10;
  for (let attempt = 0; attempt < MAX; attempt++) {
    // Cloudflare returns 524 at ~100s when the origin cannot finish; do not wait longer than that.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 110_000);
    let resp: Response;
    try {
      resp = await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      console.error(`  [timeout/network] retry ${attempt + 1}/${MAX}: ${String(e).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 60_000)));
      continue;
    }
    clearTimeout(timer);
    if (resp.status === 429 || resp.status >= 500) {
      const retryAfter = Number(resp.headers.get("retry-after")) || 0;
      const wait = Math.min(Math.max(retryAfter * 1000, 1000 * 2 ** attempt), 300_000) + Math.random() * 3000;
      console.error(`  [${resp.status}] retry ${attempt + 1}/${MAX} in ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    return resp.json();
  }
  throw new Error(`Exhausted retries: ${url.replace(API_KEY!, "***")}`);
}

export interface InboxAccount {
  id: number;
  from_email?: string;
  from_name?: string;
  created_at?: string;
  message_per_day?: number;
  type?: string;
  tags?: { id: number; name: string }[];
  warmup_details?: {
    status?: string;
    warmup_reputation?: string;
    is_warmup_blocked?: boolean;
  };
  is_smtp_success?: boolean;
  is_imap_success?: boolean;
  [key: string]: any;
}

/**
 * Page every inbox on the account. NEVER stop early on a short page mid-run.
 *
 * With `checkpoint`, every page is appended to that JSONL file as it arrives and a re-run
 * resumes from the last complete page instead of starting over. On large accounts the
 * pull can die mid-way to an account-wide 429 storm; the checkpoint turns that into a
 * restart rather than a lost run. Delete the file to force a fresh pull.
 */
export async function listAllInboxes(checkpoint?: string): Promise<InboxAccount[]> {
  const all: InboxAccount[] = [];
  const limit = 100; // hard cap: limit>100 silently returns 0 rows on this endpoint
  let offset = 0;
  let complete = false;

  if (checkpoint && existsSync(checkpoint)) {
    for (const line of readFileSync(checkpoint, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      if (rec.done) { complete = true; break; }
      all.push(...rec.rows);
      offset = rec.offset + limit;
    }
    console.error(`  resumed from checkpoint: ${all.length} inboxes${complete ? " (complete)" : `, continuing at offset ${offset}`}`);
    if (complete) return all;
  } else if (checkpoint) {
    mkdirSync(dirname(checkpoint), { recursive: true });
  }

  for (;;) {
    const url = `${API_BASE}/email-accounts?api_key=${API_KEY}&offset=${offset}&limit=${limit}`;
    const batch: InboxAccount[] = await fetchJson(url);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (checkpoint) appendFileSync(checkpoint, JSON.stringify({ offset, rows: batch }) + "\n");
    if (batch.length < limit) break;
    offset += limit;
    if (offset % 2000 === 0) console.error(`  ...${all.length} inboxes so far`);
    await new Promise((r) => setTimeout(r, 350)); // pace: back-to-back pages trip the limiter
  }
  if (checkpoint) appendFileSync(checkpoint, JSON.stringify({ done: true, total: all.length }) + "\n");
  return all;
}

export interface DomainMetric {
  domain: string;
  sent: number;
  replied: number;
  positive_replied: number;
  bounced: number;
}

/** Sub-clients on the account (empty array on a single-client account). */
export async function listClients(): Promise<{ id: number; name?: string }[]> {
  const json = await fetchJson(`${API_BASE}/client/?api_key=${API_KEY}`);
  return Array.isArray(json) ? json : [];
}

/**
 * Live per-domain sent / replied / bounced for a date window.
 *
 * Measured on a 14k-domain account: an ACCOUNT-WIDE page of 1000 never returns (Cloudflare
 * 524 at ~125s, the origin cannot finish it); a page of 100 returns in ~19s; one sub-client
 * at limit 1000 returns in ~1s. So: per client at 1000 when the account has sub-clients,
 * account-wide at 100 otherwise. With `checkpoint`, each completed page is appended to a
 * JSONL file and a re-run resumes from it.
 */
export async function domainMetrics(
  startDate: string,
  endDate: string,
  opts: { clientIds?: string[]; checkpoint?: string } = {}
): Promise<Map<string, DomainMetric>> {
  const out = new Map<string, DomainMetric>();
  const add = (rows: any[]) => {
    for (const r of rows) {
      const domain = String(r.domain || "").toLowerCase();
      if (!domain) continue;
      const prev = out.get(domain);
      out.set(domain, {
        domain,
        sent: Number(r.sent || 0) + (prev?.sent ?? 0),
        replied: Number(r.replied || 0) + (prev?.replied ?? 0),
        positive_replied: Number(r.positive_replied || 0) + (prev?.positive_replied ?? 0),
        bounced: Number(r.bounced || 0) + (prev?.bounced ?? 0),
      });
    }
  };

  // scopes: one per sub-client (fast), or a single account-wide scope (slow, small pages)
  const scopes: { client?: string; pageSize: number }[] = opts.clientIds?.length
    ? opts.clientIds.map((c) => ({ client: c, pageSize: 1000 }))
    : [{ pageSize: 100 }];

  const done = new Set<string>();
  const lastPage = new Set<string>(); // keys of pages that were the final page of their scope
  if (opts.checkpoint && existsSync(opts.checkpoint)) {
    for (const line of readFileSync(opts.checkpoint, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      done.add(rec.key);
      if (rec.last) lastPage.add(rec.key);
      add(rec.rows);
    }
    if (done.size) console.error(`  resumed metrics checkpoint: ${done.size} pages, ${out.size} domains`);
  } else if (opts.checkpoint) {
    mkdirSync(dirname(opts.checkpoint), { recursive: true });
  }

  let n = 0;
  for (const scope of scopes) {
    let offset = 0;
    for (;;) {
      const key = `${scope.client ?? "all"}:${offset}`;
      if (done.has(key)) {
        if (lastPage.has(key)) break;      // this scope finished in a previous run
        offset += scope.pageSize; continue; // page already fetched, move on
      }
      const params = new URLSearchParams({
        api_key: API_KEY!, start_date: startDate, end_date: endDate, full_data: "true",
        limit: String(scope.pageSize), offset: String(offset),
      });
      if (scope.client) params.set("client_ids", scope.client);
      const json = await fetchJson(`${API_BASE}/analytics/mailbox/domain-wise-health-metrics?${params}`);
      const rows: any[] = json?.data?.domain_health_metrics ?? [];
      add(rows);
      const last = rows.length < scope.pageSize;
      if (opts.checkpoint) appendFileSync(opts.checkpoint, JSON.stringify({ key, last, rows }) + "\n");
      n++;
      if (n % 25 === 0) console.error(`  ...metrics: ${n} pages, ${out.size} domains`);
      if (last) break;
      offset += scope.pageSize;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return out;
}

export function domainOf(inbox: InboxAccount): string {
  const email = String(inbox.from_email || inbox.email || "");
  return email.includes("@") ? email.split("@").pop()!.toLowerCase() : "";
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function writeCsv(path: string, rows: Record<string, any>[]): void {
  mkdirSync(dirname(path), { recursive: true });
  if (rows.length === 0) {
    writeFileSync(path, "");
    return;
  }
  const headers = Object.keys(rows[0]);
  const esc = (v: any) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(","));
  writeFileSync(path, lines.join("\n") + "\n");
}

export function readCsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  const lines = text.split("\n");
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
