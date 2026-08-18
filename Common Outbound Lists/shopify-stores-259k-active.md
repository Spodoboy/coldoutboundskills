# Shopify Stores — 259K Active (≥1k monthly visits)

Pre-built company list for ecommerce / Shopify-app / DTC campaigns. This is **companies, not people**.

| | |
|---|---|
| Rows | **259,293** unique domains |
| Filter | estimated monthly visits ≥ 1,000 (cut from a 1.9M-row Shopify snapshot) |
| Snapshot | store metadata May 2026; non-ecom / dead rows purged July 2026; this export 2026-08-18 |
| LinkedIn fill | **168,825** (65.1%) — blank when we do not have a company page |
| File | `Common Outbound Lists/shopify-stores-259k-active.csv.zip` → `shopify-stores.csv` (~59 MB unzipped, ~24 MB zip) |

## Columns

```
domain,merchant_name,description,company_linkedin
```

- `domain` — apex / normalized (no `www.`)
- `merchant_name` — storefront name
- `description` — store description from the snapshot
- `company_linkedin` — company LinkedIn URL when available, otherwise empty

No traffic, sales, employee, or tech-stack columns are included.

## How to use

```bash
unzip "Common Outbound Lists/shopify-stores-259k-active.csv.zip"
```

Then treat it as an `extra_candidates` CSV in `/list-builder` (it already has a `domain` column):

1. Filter or sample for the niche (keyword on `description` / `merchant_name`, or a judge pass).
2. **Required:** `/icp-prompt-builder` on ~50 rows before spending on contacts.
3. `/blitz-list-builder` (or `/list-builder` Phase 4) to find people at those domains.
4. Validate emails before upload.

## Gotchas

- **Stale liveness.** About 11–12% of “live” Shopify stores in this snapshot were dead ~2 months later (frozen 402s, dangling DNS). Verify the slice you actually mail — do not treat the full file as send-ready.
- **Not every Shopify store is a brand.** The 1.9M file was already purged of obvious non-ecom (agencies, merch arms, donation pages, wholesale-only). Residual junk still exists; the judge is the filter.
- **LinkedIn is best-effort.** 35% of rows have no company page in our enrichment. Blank ≠ “no LinkedIn exists.”
- **Companies, not contacts.** You still need a people pull + email validation.

## Source note

Filtered from GrowthEngineX’s internal Shopify master list (Active + ecom-keep + ≥1k estimated monthly visits). Public file is domain / name / description / LinkedIn only.
