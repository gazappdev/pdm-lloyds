# pdm-lloyds — Design Spec
_Date: 2026-06-11_

## Overview

A standalone Node.js Discord price-drop monitor bot for Lloyds Pharmacy, modelled on the pdm-toolshops reference project. Monitors the Lloyds `/pages/great-offers` category tree, detects new deals and price drops via the Shopify JSON API, and posts rich Discord embeds. Hosted on Bisect via GitHub.

---

## File Structure

```
pdm-lloyds/
  scraper.js              ← orchestrator: run loop, cron, monitor webhooks
  stores/
    lloyds.js             ← store module: category discovery, product fetch, cache, Discord
  lib/
    browser.js            ← shared Puppeteer factory (identical to toolshops)
  lloyds.png              ← store logo for monitor embeds
  package.json
  .env                    ← gitignored; uploaded manually to Bisect Files panel
  .gitignore
  docs/
    superpowers/
      specs/
        2026-06-11-pdm-lloyds-design.md
```

---

## Stack

- Node.js (CommonJS)
- `puppeteer` + `puppeteer-extra` + `puppeteer-extra-plugin-stealth` — category page navigation only
- `node-cron` — CSV export schedule + heartbeat
- `dotenv` — env var loading
- Native `fetch` — all Shopify JSON API product calls (no browser per product page)

---

## Runtime Flow

1. `scraper.js` calls `lloyds.scan()` in a `while(true)` loop with 120–300 min random delay between cycles
2. `scan()` opens a short-lived browser, scrapes category structure (two-tier), closes browser
3. For each discovered collection handle, calls the Shopify JSON API pages until 0 products returned
4. Change detection per product → Discord post for `new` and `priceDrop` events
5. After all categories: marks unseen active products as OOS in cache
6. Returns scan stats to orchestrator → orchestrator posts scan summary embed to monitor webhook
7. Cron: hourly heartbeat to monitor webhook; daily 06:01 CSV export to scrapesheet webhook

---

## Category Discovery (Puppeteer — Option A)

**Runs on every scan cycle. Two-tier.**

**Tier 1** — visit `https://lloydspharmacy.com/pages/great-offers`
- Extract links to main category pages (`/pages/electricals`, `/pages/hair-care`, etc.)
- Expected: 8 main categories (Baby & child, Electricals, Hair care, Health & wellbeing, Medicine & treatments, Skincare, Sexual health, Vitamins & supplements)

**Tier 2** — visit each main category page
- Extract sub-category collection handles (`blood-pressure-monitors`, `electric-toothbrushes`, etc.)
- Build `handle → URL` map for the product fetch phase

**Change detection:**
- `KNOWN_CATEGORIES` array in `lloyds.js` = expected set of collection handles
- Starts empty; populated by hand after first run confirms all handles
- On each run: compare live-discovered handles vs `KNOWN_CATEGORIES`
- Alert via monitor webhook if new handles found or known handles go missing
- `SCAN_CATEGORIES` = all discovered handles (all enabled from launch)

**Resource blocking:** images, fonts, stylesheets, media blocked on category pages to reduce load time.

---

## Product Data — Shopify JSON API

```
GET https://lloydspharmacy.com/collections/{handle}/products.json?limit=250&page=N
```

Paginate with `?page=N` (1-indexed). Stop when response array is empty.

**Field mapping:**

| Shopify field | Bot field |
|---|---|
| `variants[0].price` | `price` (string → Number) |
| `variants[0].compare_at_price` | `wasPrice` (null if absent/0) |
| `variants[0].barcode` | `ean` (EAN/GTIN — no secondary API needed) |
| `variants[0].sku` | `sku` |
| `variants[0].available` | `inStock` |
| `images[0].src` | `imageUrl` |
| `vendor` | `brand` |
| `title` | `name` |
| `handle` | slug → `https://lloydspharmacy.com/products/{handle}` |
| `id` | cache key |

A deal is active when `wasPrice > price + 0.005`.

---

## Change Detection & Cache

Cache file: `last_seen_lloyds.json` (gitignored).

| Event | Condition | Action |
|---|---|---|
| `new` | Product not in cache AND deal active (`wasPrice > price`) | Post to Discord |
| `priceDrop` | Cached active product, price decreased since last scan | Post to Discord |
| `restock` | Cached OOS product now available again | Silent cache update only — no Discord post |
| Silent | Product in cache, no deal, no price change | Cache refresh only |
| `oos` | Cached active product not seen this run | Mark `status: 'oos'` in cache |

Products without an active deal are cached silently and never posted.

---

## Discord Embeds

**Embed colour:** `0x00833E` (Lloyds green)

**Title prefix:** `🆕` (new) or `📉` (price drop)

**Fields:**
- `__**Product Details**__` — Brand, SKU, EAN/GTIN
- `__**Pricing**__` — Now £X.XX / Was £X.XX / Save N%
- `🔍 EAN Search` — SAS | Amazon | eBay Active | eBay Sold (keyed on EAN)
- `🔎 Title Search` — SAS | Amazon | eBay Active | eBay Sold (keyed on title)

**Footer:** "Powered by Reseller Hub" + icon URL

**Role pings (shared thresholds):**
- ≥75% off → `<@&1482059276397842513>`
- ≥50% off → `<@&1482059204255809597>`
- ≥30% off → `<@&1482058952257568799>`

---

## Environment Variables

`.env` file — created locally with placeholders, gitignored, uploaded manually to Bisect Files panel after deployment.

```
# Lloyds Pharmacy — product webhook
LLOYDS_WEBHOOK_URL=YOUR_LLOYDS_WEBHOOK_URL_HERE
LLOYDS_WEBHOOK_URL_2=YOUR_LLOYDS_WEBHOOK_URL_2_HERE

# Shared — daily CSV scrapesheet
SCRAPESHEET_WEBHOOK_URL=YOUR_SCRAPESHEET_WEBHOOK_URL_HERE
SCRAPESHEET_WEBHOOK_URL_2=YOUR_SCRAPESHEET_WEBHOOK_URL_2_HERE

# Shared — monitor / health
MONITOR_WEBHOOK_URL=YOUR_MONITOR_WEBHOOK_URL_HERE

# Browser
HEADLESS=true
CHROME_PATH=
```

---

## Monitor Embed (per scan summary)

Posted to `MONITOR_WEBHOOK_URL` after each full scan. Fields:
- Pages scraped, unique products seen
- New deals, price drops, OOS count
- Per-category breakdown (handle, products seen, pages, new, drops)
- New/missing category alerts if any
- Scan duration, next run time

Hourly heartbeat: plain text message with timestamp.

---

## CSV Export

Runs daily at 06:01 UK time. Posted to `SCRAPESHEET_WEBHOOK_URL` and `_2`.

Columns: Image (=IMAGE formula), Title, Brand, EAN, SKU, Product URL, Now Price, Was Price, Discount %, SAS, Amazon, eBay Active, eBay Sold.

Previous day's CSV deleted before writing new one.

---

## Git & Bisect Setup

**GitHub repo:** `https://github.com/gazappdev/pdm-lloyds`

**Bisect Startup Variables:**

| Field | Value |
|---|---|
| Git Repo Address | `https://github.com/gazappdev/pdm-lloyds` |
| Git Username | `gazappdev` |
| Git Access Token | GitHub PAT with `repo` scope |
| Install Branch | `main` |
| Main file | `scraper.js` |
| Auto Update | Enabled |

**GitHub PAT path:**
GitHub → profile → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → name it `bisect-pdm-lloyds` → check `repo` scope → Generate → copy immediately (shown once only)

**Key requirements:**
- `package.json` `postinstall` runs `npx puppeteer browsers install chrome` — installs bundled Chromium automatically on Bisect deploy
- `CHROME_PATH` must be blank — bot uses bundled Chromium
- `HEADLESS=true` in `.env`
- `console.log('successfully finished startup')` must appear in `scraper.js` before first webhook call — Bisect uses this string to detect the server is online
- `.env` uploaded via Bisect Files panel after first deployment — never committed to git
- No PM2 — Bisect manages the process

---

## Startup Sequence (Bisect)

1. Bisect clones repo from GitHub using PAT
2. Runs `npm install` → triggers `postinstall` → Chromium installed
3. Runs `node scraper.js`
4. Bot logs `successfully finished startup` → Bisect marks server online
5. First scan begins
