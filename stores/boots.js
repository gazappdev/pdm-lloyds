'use strict';

const fs   = require('fs');
const path = require('path');

// ===== CONFIG =====
const STORE_NAME = 'Boots';
const ORIGIN     = 'https://www.boots.com';
const STORE_ID   = '11352';
// The WCS API serves up to 200 per page; 100 keeps responses ~1.5MB and cuts the
// request count roughly fourfold against the old 24 (verified 2026-10-07).
const PAGE_SIZE  = 100;

// Numeric category IDs — text identifiers are blocked by Incapsula; numeric IDs bypass it.
// To add more categories: run node scripts/test-boots.js (TEST_BOOTS=1 on Bisect) and drill the tree.
// postNew: a product first appearing here is posted as a new deal even without a was-price.
// The Boots feed carries one selling price and almost never a was-price, so membership of an
// offer category is the only "on offer" signal there is. Hair is the full department, not an
// offer list, so it stays price-drop only and is scanned last.
const CATEGORIES = [
  { id: '2608697', label: 'Skincare Savings',      postNew: true },
  { id: '1595059', label: 'Toiletries Offers',     postNew: true },
  { id: '1595046', label: 'Fragrance Offers',      postNew: true },
  { id: '1595111', label: 'Electrical Offers',     postNew: true },
  { id: '1595033', label: 'Health Offers',         postNew: true },
  { id: '1595042', label: 'Skincare Offers',       postNew: true },
  { id: '1595072', label: 'Opticians Offers',      postNew: true },
  { id: '2921187', label: 'Makeup Offers',         postNew: true },
  { id: '1595110', label: 'Baby & Child Offers',   postNew: true },
  { id: '1595224', label: 'Sale',                  postNew: true },
  { id: '1923680', label: 'Clearance',             postNew: true },
  { id: '2583681', label: '£10 Tuesday',           postNew: true },
  { id: '1891719', label: 'Value Packs & Bundles', postNew: true },
  { id: '1595040', label: 'Hair',                  postNew: false },
];

// Large event categories (~4,900 products each). Scanning them whole every run would more
// than double the request volume, so each scan walks ROTATING_PAGES_PER_SCAN pages and the
// next scan resumes where this one stopped (cursor persisted in the cache file). At 35 pages
// of 100 the full ~100 pages are covered roughly every 3 scans.
const ROTATING_CATEGORIES = [
  { id: '3505684', label: 'Super Savings Event',   postNew: true },
  { id: '2407680', label: 'Premium Beauty Offers', postNew: true },
];
const ROTATING_PAGES_PER_SCAN = parseInt(process.env.BOOTS_ROTATING_PAGES || '35', 10);

// Categories the bot scanned before per-category seeding existed. An existing cache with no
// `seeded` map is treated as already seeded for these so the upgrade posts nothing spurious.
const LEGACY_SEEDED = ['2608697', '1595059', '1595046', '1595111', '1595040', '1595033', '1595042', '1595072', '2921187', '1595110'];

// Ceiling on new-deal posts per scan. An event switch can move hundreds of products into an
// offer category at once; anything over the cap is cached silently and logged.
const MAX_NEW_POSTS_PER_SCAN = parseInt(process.env.BOOTS_MAX_NEW_POSTS || '40', 10);

const EMBED_COLOR = 0x003DA5; // Boots blue (Pantone 286C)
const CACHE_FILE  = path.resolve(__dirname, '..', 'last_seen_boots.json');
const LOGO_FILE   = path.resolve(__dirname, '..', 'boots.png');
const FOOTER_TEXT = 'Powered by Reseller Hub';
const FOOTER_ICON = 'https://i.imgur.com/aXI4ucP.png';

const MIN_POST_DELAY_MS        = 1500;
const COLD_START_PREVIEW_COUNT = 5;

const DISCOUNT_ROLES = [
  { minPct: 75, roleId: '1482059276397842513' },
  { minPct: 50, roleId: '1482059204255809597' },
  { minPct: 30, roleId: '1482058952257568799' },
];

const API_HEADERS = {
  'Accept':          'application/json, */*;q=0.9',
  'Accept-Language': 'en-GB,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Cache-Control':   'no-cache',
};

// ===== CACHE =====
if (!fs.existsSync(CACHE_FILE)) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ items: {} }, null, 2));
}

function loadCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!parsed.items || typeof parsed.items !== 'object') parsed.items = {};
    return parsed;
  } catch { return { items: {} }; }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ===== HELPERS =====
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ===== API FETCHERS =====
async function fetchCategoryPage(categoryId, pageNum) {
  const url = `${ORIGIN}/search/resources/store/${STORE_ID}/productview/byCategory/${categoryId}?pageSize=${PAGE_SIZE}&pageNumber=${pageNum}&lang=-1`;
  try {
    const res = await fetch(url, { headers: API_HEADERS });
    if (!res.ok) {
      console.warn(`[${STORE_NAME}] Category ${categoryId} p${pageNum}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return {
      products: data.catalogEntryView || [],
      total:    parseInt(data.recordSetTotal || data.recordSetTotalMatches || '0', 10),
    };
  } catch (e) {
    console.warn(`[${STORE_NAME}] Fetch error ${categoryId} p${pageNum}: ${e.message}`);
    return null;
  }
}

async function fetchProductDetail(uniqueID) {
  const url = `${ORIGIN}/search/resources/store/${STORE_ID}/productview/byId/${uniqueID}?lang=-1`;
  try {
    const res = await fetch(url, { headers: API_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.catalogEntryView || [])[0] || null;
  } catch { return null; }
}

// ===== PRODUCT PARSER =====
function parseProduct(raw, categoryLabel, source) {
  if (!raw || !raw.uniqueID) return null;

  const id   = String(raw.uniqueID);
  const name = (raw.name || raw.shortDescription || '').trim();
  if (!name) return null;

  // Price: Display/L = current sale price (lower), Offer/I = normal/was price (higher)
  const displayVal = raw.price?.find(x => x.usage === 'Display')?.value;
  const offerVal   = raw.price?.find(x => x.usage === 'Offer')?.value;
  const displayNum = displayVal ? parseFloat(displayVal) : NaN;
  const offerNum   = offerVal   ? parseFloat(offerVal)   : NaN;

  const price    = !isNaN(displayNum) ? displayNum : (!isNaN(offerNum) ? offerNum : null);
  const wasPrice = !isNaN(offerNum) && !isNaN(displayNum) && offerNum > displayNum + 0.005 ? offerNum : null;

  if (price == null || isNaN(price)) return null;

  const hasDeal     = wasPrice != null;
  const discountPct = hasDeal ? Math.round((wasPrice - price) / wasPrice * 100) : null;

  // EAN from barcode attribute (100% populated in Boots WCS)
  const ean = raw.attributes?.find(a => a.identifier === 'barcode')?.values?.[0]?.value || null;

  const partNum = (raw.partNumber || '').replace('.P', '');

  return {
    id,
    name,
    brand:       (raw.manufacturer || '').trim(),
    price,
    wasPrice:    hasDeal ? wasPrice    : null,
    discountPct: hasDeal ? discountPct : null,
    ean,
    sku:         raw.partNumber || null,
    partNum,
    uniqueID:    id,
    imageUrl:    '',   // enriched before Discord post
    productUrl:  '',   // enriched before Discord post
    inStock:     raw.buyable === 'true',
    source:      source || 'boots-category',
    collection:  categoryLabel,
  };
}

// Fetch SEO URL and image for a product about to be posted to Discord.
// Mirrors the GTIN-fetch pattern in lloyds.js — only runs for products being posted.
async function enrichProduct(product) {
  await sleep(300 + randInt(0, 200));
  const detail = await fetchProductDetail(product.uniqueID);

  if (detail) {
    // SEO URL: first token from seo_token_ntk (semicolon-separated variants)
    const seoToken = detail.sKUs?.[0]?.seo_token_ntk?.split(';')[0];
    product.productUrl = seoToken
      ? `${ORIGIN}/${seoToken}`
      : `${ORIGIN}/search?q=${encodeURIComponent(product.partNum)}`;

  } else {
    product.productUrl = `${ORIGIN}/search?q=${encodeURIComponent(product.partNum)}`;
  }

  // Scene7 CDN — confirmed in probe run 7; constructed from partNum, no API call needed.
  product.imageUrl = `https://boots.scene7.com/is/image/Boots/${product.partNum}`;
}

// ===== CHANGE DETECTION =====
function processProduct(p, cache, seenThisRun, postNew) {
  // Categories overlap heavily; the first sighting in a run is the one that counts.
  if (seenThisRun.has(p.id)) return { type: null };
  seenThisRun.add(p.id);
  const prev = cache.items[p.id];

  if (!prev) {
    cache.items[p.id] = { ...p, status: 'active' };
    return (p.wasPrice != null || postNew)
      ? { type: 'new', product: cache.items[p.id] }
      : { type: null };
  }

  const prevPrice = prev.price;
  const dropped   = prevPrice != null && p.price < prevPrice - 0.005;

  // Back after dropping out of the scanned categories. Offers rotate, so a product that
  // returns cheaper than when it was last seen is a price drop, not a silent restock.
  if (prev.status === 'oos' && !dropped) {
    cache.items[p.id] = { ...prev, ...p, ean: prev.ean || p.ean, status: 'active' };
    return { type: 'restock', product: cache.items[p.id] };
  }

  if (dropped) {
    const newPct = Math.round((1 - p.price / prevPrice) * 100);
    cache.items[p.id] = {
      ...prev,
      price:       p.price,
      wasPrice:    prevPrice,
      discountPct: newPct,
      name:        p.name,
      brand:       p.brand,
      inStock:     p.inStock,
      source:      p.source,
      collection:  p.collection,
      status:      'active',
    };
    return { type: 'priceDrop', product: cache.items[p.id] };
  }

  cache.items[p.id].name        = p.name;
  cache.items[p.id].brand       = p.brand;
  cache.items[p.id].inStock     = p.inStock;
  cache.items[p.id].source      = p.source;
  cache.items[p.id].price       = p.price;
  cache.items[p.id].wasPrice    = p.wasPrice;
  cache.items[p.id].discountPct = p.discountPct;
  return { type: null };
}

// ===== DISCORD HELPERS =====
let lastWebhookPostAt = 0;

async function enforcePostSpacing() {
  const delta = Date.now() - lastWebhookPostAt;
  if (delta < MIN_POST_DELAY_MS) await sleep(MIN_POST_DELAY_MS - delta);
  lastWebhookPostAt = Date.now();
}

function parseRetryAfterMs(res, bodyJson) {
  const ra  = res.headers?.get?.('retry-after');
  const rsa = res.headers?.get?.('x-ratelimit-reset-after');
  let waitSec = 0;
  if (ra)                         waitSec = parseFloat(ra);
  else if (rsa)                   waitSec = parseFloat(rsa);
  else if (bodyJson?.retry_after) waitSec = Number(bodyJson.retry_after);
  return Math.max(0, waitSec * 1000) + 250;
}

async function sendWebhookJSON(url, payload) {
  for (let i = 0; i < 5; i++) {
    await enforcePostSpacing();
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (res.status !== 429) return res;
    const body   = await res.json().catch(() => ({}));
    const waitMs = parseRetryAfterMs(res, body) || 3000;
    console.warn(`[${STORE_NAME}] 429 rate limit — backing off ${waitMs}ms`);
    await sleep(waitMs);
  }
  return { ok: false, status: 429 };
}

function quoteLines(lines) {
  return '> ' + lines.filter(Boolean).join('\n> ');
}

function makeEmbed(p, type) {
  const prefix = type === 'new' ? '🆕 ' : '📉 ';

  const detailLines = [
    p.brand ? `Brand: ${p.brand}`        : null,
    p.sku   ? `SKU: \`${p.sku}\``        : null,
    p.ean   ? `EAN / GTIN: \`${p.ean}\`` : 'EAN / GTIN: not available',
  ].filter(Boolean);

  const pricingLines = [`Now: £${p.price.toFixed(2)}`];
  if (p.wasPrice)    pricingLines.push(`Was: £${p.wasPrice.toFixed(2)}`);
  if (p.discountPct) pricingLines.push(`Save: ${p.discountPct}%`);

  const eanQ   = p.ean ? encodeURIComponent(p.ean) : null;
  const titleQ = encodeURIComponent(capSearchQuery(p.name || ''));

  function searchLinks(q) {
    return (
      `[SAS](https://sas.selleramp.com/sas/lookup?sasLookup&search_term=${q})` +
      ` | [Amazon](https://www.amazon.co.uk/s?k=${q})` +
      ` | [eBay Active](https://www.ebay.co.uk/sch/i.html?_nkw=${q})` +
      ` | [eBay Sold](https://www.ebay.co.uk/sch/i.html?_nkw=${q}&LH_Complete=1&LH_Sold=1)`
    );
  }

  const embed = {
    title:     prefix + p.name,
    url:       p.productUrl || ORIGIN,
    color:     EMBED_COLOR,
    fields: [
      { name: '__**Product Details**__', value: quoteLines(detailLines),                                      inline: false },
      { name: '__**Pricing**__',         value: quoteLines(pricingLines),                                     inline: false },
      { name: '🔍 EAN Search',           value: quoteLines([eanQ ? searchLinks(eanQ) : 'EAN not available']), inline: false },
      { name: '🔎 Title Search',         value: quoteLines([searchLinks(titleQ)]),                            inline: false },
    ],
    footer:    { text: FOOTER_TEXT, icon_url: FOOTER_ICON },
    timestamp: new Date().toISOString(),
  };

  if (p.imageUrl) embed.thumbnail = { url: p.imageUrl };

  return embed;
}

async function postToDiscord(p, type) {
  const webhookUrl  = process.env.BOOTS_WEBHOOK_URL   || '';
  const webhookUrl2 = process.env.BOOTS_WEBHOOK_URL_2 || '';
  if (!webhookUrl) { console.warn(`[${STORE_NAME}] No BOOTS_WEBHOOK_URL — skipping.`); return; }

  const embed = makeEmbed(p, type);

  let roleMention = null;
  if (p.discountPct && !isNaN(p.discountPct)) {
    const match = DISCOUNT_ROLES.find(r => p.discountPct >= r.minPct);
    if (match) roleMention = `<@&${match.roleId}>`;
  }

  const postToUrl = async (url) => {
    if (roleMention) {
      const matched = DISCOUNT_ROLES.find(r => roleMention.includes(r.roleId));
      await sendWebhookJSON(url, {
        content:          roleMention,
        allowed_mentions: { roles: [matched.roleId] },
      });
    }
    return sendWebhookJSON(url, { embeds: [embed] });
  };

  const res = await postToUrl(webhookUrl);
  if (res.ok) {
    console.log(`[${STORE_NAME}] Posted ${type}: ${p.name}`);
    if (webhookUrl2) {
      postToUrl(webhookUrl2).then(r => {
        if (!r.ok) console.warn(`[${STORE_NAME}] Webhook 2 failed: ${r.status}`);
      }).catch(err => console.warn(`[${STORE_NAME}] Webhook 2 error: ${err.message}`));
    }
  } else {
    console.error(`[${STORE_NAME}] Discord post failed: ${res.status}`);
  }
}

// ===== CATEGORY SCRAPER =====
// Runs change detection over one page of parsed products and posts what qualifies.
// `run` carries the per-scan state shared by every category: cache, seenThisRun, coldStart,
// coldStartBudget and newPostsLeft. `seeded` is false until the category has been walked
// once in full; until then its new arrivals are cached silently (price drops still post).
async function handleItems(items, cat, seeded, run, tally) {
  for (const p of items) {
    const detection = processProduct(p, run.cache, run.seenThisRun, cat.postNew);
    if (detection.type === 'priceDrop') tally.totPriceDrops++;
    if (detection.type === 'restock')   tally.totRestocks++;

    let shouldPost = false;
    if (detection.type === 'priceDrop') {
      shouldPost = !run.coldStart;
    } else if (detection.type === 'new') {
      if (run.coldStart) {
        tally.totNew++;
        shouldPost = detection.product.wasPrice != null && run.coldStartBudget.remaining > 0;
      } else if (!seeded) {
        tally.silentNew++;
      } else if (run.newPostsLeft <= 0) {
        tally.cappedNew++;
      } else {
        run.newPostsLeft--;
        tally.totNew++;
        shouldPost = true;
      }
    }

    if (shouldPost) {
      await enrichProduct(detection.product);
      // Persist enriched URLs to cache
      if (run.cache.items[detection.product.id]) {
        run.cache.items[detection.product.id].productUrl = detection.product.productUrl;
        run.cache.items[detection.product.id].imageUrl   = detection.product.imageUrl;
      }
      await postToDiscord(detection.product, detection.type);
      if (run.coldStart) run.coldStartBudget.remaining--;
    }
  }
}

const newTally = () => ({ totNew: 0, totPriceDrops: 0, totRestocks: 0, silentNew: 0, cappedNew: 0 });

async function scrapeCategory(cat, run) {
  const { id, label } = cat;
  const { cache, coldStart, coldStartBudget } = run;
  const seeded = !!cache.seeded[id];
  const tally  = newTally();
  let pagesScraped = 0, totSeen = 0, complete = false;
  let totalPages = 1;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    if (pageNum > 1) await sleep(600 + randInt(0, 400));

    const result = await fetchCategoryPage(id, pageNum);
    if (!result) {
      if (pageNum === 1) {
        console.warn(`[${STORE_NAME}] No response for ${label}`);
        return { ...tally, pagesScraped, seen: 0, error: true };
      }
      break;
    }

    if (pageNum === 1) {
      totalPages = Math.ceil(result.total / PAGE_SIZE);
      console.log(`\n[${STORE_NAME}] ${label}: ${result.total} products, ${totalPages} pages${coldStart ? ` (cold start — ${coldStartBudget.remaining} preview posts remaining)` : ''}${!coldStart && !seeded ? ' (first full scan — new arrivals cached silently)' : ''}`);
    }

    const items = result.products.map(r => parseProduct(r, label)).filter(Boolean);
    totSeen += items.length;
    pagesScraped++;
    console.log(`  [${STORE_NAME}] Page ${pageNum}: ${items.length} products`);

    await handleItems(items, cat, seeded, run, tally);
    if (pageNum >= totalPages) complete = true;
    saveCache(cache);
  }

  if (complete && !seeded) { cache.seeded[id] = true; saveCache(cache); }
  if (tally.silentNew) console.log(`  [${STORE_NAME}] ${label}: ${tally.silentNew} new arrivals cached silently (seeding)`);
  if (tally.cappedNew) console.log(`  [${STORE_NAME}] ${label}: ${tally.cappedNew} new arrivals over the per-scan cap, cached silently`);

  return { ...tally, pagesScraped, seen: totSeen };
}

// Walks up to ROTATING_PAGES_PER_SCAN pages of the rotating categories, resuming from the
// cursor the previous scan left in the cache. A failed page leaves the cursor where it is.
async function scrapeRotating(run) {
  const { cache } = run;
  const summary = new Map();
  let pagesLeft = ROTATING_PAGES_PER_SCAN, catsCompleted = 0, first = true;

  if (!cache.rotation || !ROTATING_CATEGORIES[cache.rotation.cat]) cache.rotation = { cat: 0, page: 1 };

  while (pagesLeft > 0 && catsCompleted < ROTATING_CATEGORIES.length) {
    const cur = cache.rotation;
    const cat = ROTATING_CATEGORIES[cur.cat];
    if (!summary.has(cat.id)) summary.set(cat.id, { label: cat.label, ...newTally(), pagesScraped: 0, seen: 0 });
    const entry = summary.get(cat.id);

    if (!first) await sleep(600 + randInt(0, 400));
    first = false;

    const result = await fetchCategoryPage(cat.id, cur.page);
    if (!result) { entry.error = true; break; }
    pagesLeft--;

    const totalPages = Math.ceil(result.total / PAGE_SIZE);
    const items = result.products.map(r => parseProduct(r, cat.label, 'boots-rotating')).filter(Boolean);
    entry.pagesScraped++;
    entry.seen += items.length;
    console.log(`  [${STORE_NAME}] ${cat.label} (rotating) page ${cur.page}/${totalPages}: ${items.length} products`);

    await handleItems(items, cat, !!cache.seeded[cat.id], run, entry);

    if (cur.page >= totalPages) {
      // Reaching the end means every page has been walked since the cursor last sat at 1.
      cache.seeded[cat.id] = true;
      cache.rotation = { cat: (cur.cat + 1) % ROTATING_CATEGORIES.length, page: 1 };
      catsCompleted++;
    } else {
      cache.rotation = { cat: cur.cat, page: cur.page + 1 };
    }
    saveCache(cache);
  }

  const next = ROTATING_CATEGORIES[cache.rotation.cat];
  console.log(`[${STORE_NAME}] Rotating scan paused — next run resumes at ${next.label} page ${cache.rotation.page}`);
  return [...summary.values()];
}

// ===== MAIN SCAN =====
async function scan() {
  const cache       = loadCache();
  const coldStart   = Object.keys(cache.items).length === 0;
  const seenThisRun = new Set();
  let totNew = 0, totPriceDrops = 0, totRestocks = 0, totPages = 0, corePages = 0;
  const categorySummary  = [];
  const coldStartBudget  = { remaining: COLD_START_PREVIEW_COUNT };

  if (!cache.seeded || typeof cache.seeded !== 'object') {
    cache.seeded = {};
    if (!coldStart) for (const id of LEGACY_SEEDED) cache.seeded[id] = true;
  }
  const run = { cache, seenThisRun, coldStart, coldStartBudget, newPostsLeft: MAX_NEW_POSTS_PER_SCAN };

  if (coldStart) console.log(`[${STORE_NAME}] Cold start — posting first ${COLD_START_PREVIEW_COUNT} deals for verification, caching rest silently.`);

  const addResult = (label, result) => {
    totNew        += result.totNew;
    totPriceDrops += result.totPriceDrops;
    totRestocks   += result.totRestocks || 0;
    totPages      += result.pagesScraped;
    categorySummary.push({
      label,
      new:      result.totNew,
      drops:    result.totPriceDrops,
      restocks: result.totRestocks || 0,
      pages:    result.pagesScraped,
      seen:     result.seen,
      error:    result.error || false,
    });
  };

  for (const cat of CATEGORIES) {
    let result;
    try {
      result = await scrapeCategory(cat, run);
    } catch (err) {
      console.error(`[${STORE_NAME}] Error on ${cat.label}:`, err.message);
      categorySummary.push({ label: cat.label, new: 0, drops: 0, pages: 0, error: true });
      continue;
    }
    corePages += result.pagesScraped;
    addResult(cat.label, result);
  }

  try {
    for (const result of await scrapeRotating(run)) addResult(result.label, result);
  } catch (err) {
    console.error(`[${STORE_NAME}] Error on rotating categories:`, err.message);
  }

  // Mark OOS — core categories only. Rotating items are seen every few scans by design,
  // so absence from one run says nothing about them.
  let totOos = 0;
  if (corePages > 0) {
    for (const id of Object.keys(cache.items)) {
      const it = cache.items[id];
      if (!it || it.source !== 'boots-category') continue;
      if (seenThisRun.has(id)) continue;
      if (it.status === 'active') {
        cache.items[id].status = 'oos';
        totOos++;
        console.log(`[${STORE_NAME}] OOS: ${it.name}`);
      }
    }
  }
  saveCache(cache);

  const totalCached = Object.keys(cache.items).length;
  console.log(`\n[${STORE_NAME}] Done. Cached: ${totalCached}. New: ${totNew}  Drops: ${totPriceDrops}  OOS: ${totOos}`);

  return {
    storeName:    STORE_NAME,
    color:        EMBED_COLOR,
    logoFile:     LOGO_FILE,
    uniqueSeen:   seenThisRun.size,
    pagesScraped: totPages,
    totNew,
    totPriceDrops,
    totRestocks,
    totOos,
    coldStart,
    coldStartPreviewSent: coldStart ? COLD_START_PREVIEW_COUNT - coldStartBudget.remaining : 0,
    categorySummary,
    totalCached,
    newCats:     [],
    missingCats: [],
  };
}

// ===== CSV EXPORT =====
function csvEscape(val) {
  const s = String(val == null ? '' : val);
  if (s.includes('"') || s.includes(',') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function exportCSV(scrapesheetWebhook, scrapesheetWebhook2) {
  const cache   = loadCache();
  const today   = new Date();
  const dateStr = String(today.getDate()).padStart(2, '0') + '-' +
                  String(today.getMonth() + 1).padStart(2, '0') + '-' +
                  today.getFullYear();
  const filename = `BootsScrape-${dateStr}.csv`;
  const filepath  = path.resolve(__dirname, '..', filename);

  try {
    const rootDir = path.resolve(__dirname, '..');
    fs.readdirSync(rootDir)
      .filter(f => f.startsWith('BootsScrape-') && f.endsWith('.csv') && f !== filename)
      .forEach(f => fs.unlinkSync(path.join(rootDir, f)));
  } catch {}

  const headers = [
    'Image', 'Title', 'Brand', 'EAN', 'SKU', 'Product URL',
    'Now Price', 'Was Price', 'Discount %',
    'SAS', 'Amazon', 'eBay Active', 'eBay Sold',
  ];
  const rows = [headers.map(csvEscape).join(',')];

  for (const item of Object.values(cache.items).filter(it => it.source === 'boots-category' || it.source === 'boots-rotating')) {
    const enc = encodeURIComponent(capSearchQuery(item.ean || item.name || ''));
    rows.push([
      item.imageUrl   ? `=IMAGE("${item.imageUrl}")` : '',
      item.name       || '',
      item.brand      || '',
      item.ean        || 'not available',
      item.sku        || '',
      item.productUrl || '',
      item.price    != null ? `£${item.price.toFixed(2)}`    : 'N/A',
      item.wasPrice != null ? `£${item.wasPrice.toFixed(2)}` : '',
      item.discountPct      ? `${item.discountPct}%`         : '',
      `https://sas.selleramp.com/sas/lookup?sasLookup&search_term=${enc}`,
      `https://www.amazon.co.uk/s?k=${enc}`,
      `https://www.ebay.co.uk/sch/i.html?_nkw=${enc}`,
      `https://www.ebay.co.uk/sch/i.html?_nkw=${enc}&LH_Complete=1&LH_Sold=1`,
    ].map(csvEscape).join(','));
  }

  fs.writeFileSync(filepath, '﻿' + rows.join('\r\n'), 'utf8');
  console.log(`[${STORE_NAME}] CSV exported: ${filename} (${rows.length - 1} products)`);

  if (!scrapesheetWebhook) { console.warn(`[${STORE_NAME}] No SCRAPESHEET_WEBHOOK_URL — skipping.`); return; }

  for (const webhook of [scrapesheetWebhook, scrapesheetWebhook2].filter(Boolean)) {
    try {
      const buf  = fs.readFileSync(filepath);
      const form = new FormData();
      form.append('files[0]', new Blob([buf], { type: 'text/csv' }), filename);
      await fetch(webhook, { method: 'POST', body: form });
    } catch (err) { console.error(`[${STORE_NAME}] CSV post error: ${err.message}`); }
  }
  console.log(`[${STORE_NAME}] CSV posted to scrapesheet.`);
}

module.exports = {
  config: { name: STORE_NAME },
  scan,
  exportCSV,
  _test: { processProduct, handleItems, newTally },
};

// --- Discord field-limit guard (added 2026-10-02) ---------------------------
// Discord allows 1024 characters per embed field. The search-links field
// encodes the product name into four separate links, so a long name is
// multiplied roughly fourfold and blows that limit. Discord then rejects the
// whole embed with a 400 and the lead is silently lost - iHerb was dropping 59
// products this way and the Asda/Game/Studio group nearly 200. Cap the search
// term: 120 characters is far more than any search engine makes use of, and an
// EAN or product id is far shorter than the cap so it passes through untouched.
function capSearchQuery(value, maxRaw = 120, maxEncoded = 180) {
  let s = String(value == null ? '' : value).trim();
  if (s.length > maxRaw) {
    s = s.slice(0, maxRaw);
    const cut = s.lastIndexOf(' ');
    if (cut > 40) s = s.slice(0, cut);
  }
  // Encoding can treble the length (a space becomes %20), so a raw cap alone
  // does not bound the field. Trim until the encoded form fits as well.
  while (s.length && encodeURIComponent(s).length > maxEncoded) s = s.slice(0, -8);
  return s.trim();
}
