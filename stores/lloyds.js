'use strict';

const fs   = require('fs');
const path = require('path');
const { launch: launchBrowser, forceClose: closeBrowser } = require('../lib/browser');

// ===== CONFIG =====
const STORE_NAME  = 'Lloyds Pharmacy';
const ORIGIN      = 'https://lloydspharmacy.com';
const OFFERS_URL  = 'https://lloydspharmacy.com/pages/great-offers';
const CACHE_FILE      = path.resolve(__dirname, '..', 'last_seen_lloyds.json');
const CATEGORIES_FILE = path.resolve(__dirname, '..', 'known_categories_lloyds.json');

const EMBED_COLOR = 0x00833E;
const LOGO_FILE   = path.resolve(__dirname, '..', 'lloyds.png');
const FOOTER_TEXT = 'Powered by Reseller Hub';
const FOOTER_ICON = 'https://i.imgur.com/aXI4ucP.png';

const PAGE_LOAD_TIMEOUT_MS = 90000;
const MIN_POST_DELAY_MS    = 1500;

const BLOCK_RESOURCE_TYPES = new Set(['image', 'font', 'stylesheet', 'media', 'websocket', 'ping']);

const DISCOUNT_ROLES = [
  { minPct: 75, roleId: '1482059276397842513' },
  { minPct: 50, roleId: '1482059204255809597' },
  { minPct: 30, roleId: '1482058952257568799' },
];

// Persisted to known_categories_lloyds.json — updated automatically after each scan.
// No manual intervention needed: bot alerts on additions/removals and scans everything it finds.
function loadKnownCategories() {
  try {
    const data = JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function saveKnownCategories(handles) {
  fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(handles, null, 2));
}

// ===== HELPERS =====
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

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

// ===== CATEGORY DISCOVERY =====
async function checkCategories(page) {
  console.log(`[${STORE_NAME}] Discovering categories from ${OFFERS_URL}...`);
  await page.goto(OFFERS_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
  await sleep(2000 + randInt(0, 1000));

  // Tier 1: extract main category page links (/pages/*)
  const categoryPageLinks = await page.evaluate((offersUrl) => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/pages/"]'))
      .map(a => ({ text: a.textContent.trim(), href: a.href }))
      .filter(a => {
        if (!a.href || a.href === offersUrl)              return false;
        if (!a.href.match(/\/pages\/[^/?#]+$/))           return false;
        if (seen.has(a.href))                             return false;
        seen.add(a.href);
        return true;
      });
  }, OFFERS_URL);

  console.log(`[${STORE_NAME}] Found ${categoryPageLinks.length} main category pages`);

  // Tier 2: visit each category page and extract sub-category collection handles
  const discoveredHandles = [];
  for (const cat of categoryPageLinks) {
    await page.goto(cat.href, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
    await sleep(1500 + randInt(0, 500));

    const subCats = await page.evaluate(() => {
      const seen = new Set();
      return Array.from(document.querySelectorAll('a[href*="/collections/"]'))
        .map(a => {
          const m = a.href.match(/\/collections\/([^/?#]+)/);
          return m ? { handle: m[1], text: a.textContent.trim() } : null;
        })
        .filter(item => {
          if (!item)               return false;
          if (seen.has(item.handle)) return false;
          seen.add(item.handle);
          return true;
        });
    });

    for (const sub of subCats) {
      discoveredHandles.push({ handle: sub.handle, parentPage: cat.text });
    }
    console.log(`[${STORE_NAME}]   ${cat.text}: ${subCats.length} sub-categories`);
  }

  // Compare vs persisted known categories, then save the current live set
  const knownHandles = loadKnownCategories();
  const knownSet     = new Set(knownHandles);
  const liveHandles  = discoveredHandles.map(d => d.handle);
  const liveSet      = new Set(liveHandles);
  const newCats      = discoveredHandles.filter(d => !knownSet.has(d.handle));
  const missingCats  = knownHandles.filter(h => !liveSet.has(h));

  if (newCats.length)     console.log(`[${STORE_NAME}] NEW handles: ${newCats.map(d => d.handle).join(', ')}`);
  if (missingCats.length) console.log(`[${STORE_NAME}] MISSING handles: ${missingCats.join(', ')}`);

  // Always persist the current live set — keeps the file in sync automatically
  saveKnownCategories(liveHandles);

  return { discoveredHandles, newCats, missingCats };
}

// ===== SHOPIFY PRODUCT FETCHER =====
async function fetchCollectionPage(handle, pageNum) {
  const url = `${ORIGIN}/collections/${handle}/products.json?limit=250&page=${pageNum}`;
  try {
    const res = await fetch(url, {
      headers: {
        'Accept':          'application/json',
        'Accept-Language': 'en-GB,en;q=0.9',
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) {
      console.warn(`  [${STORE_NAME}] Collection fetch ${res.status} for ${handle} page ${pageNum}`);
      return null;
    }
    const data = await res.json();
    return data.products || [];
  } catch (e) {
    console.warn(`  [${STORE_NAME}] Fetch error ${handle} p${pageNum}: ${e.message}`);
    return null;
  }
}

// ===== PRODUCT PARSER =====
// Shopify returns prices as strings — cast to Number.
// EAN comes from variants[0].barcode — no secondary API call needed.
function parseProduct(raw, collectionHandle) {
  if (!raw || !raw.id) return null;
  const variant = (raw.variants || [])[0];
  if (!variant) return null;

  const id   = String(raw.id);
  const name = (raw.title || '').trim();
  if (!name) return null;

  const price    = variant.price != null ? Number(variant.price) : null;
  const wasPrice = variant.compare_at_price && Number(variant.compare_at_price) > 0
    ? Number(variant.compare_at_price) : null;
  if (price == null) return null;

  const hasDeal     = wasPrice != null && wasPrice > price + 0.005;
  const discountPct = hasDeal ? Math.round((wasPrice - price) / wasPrice * 100) : null;

  return {
    id,
    name,
    brand:       (raw.vendor || '').trim(),
    price,
    wasPrice:    hasDeal ? wasPrice    : null,
    discountPct: hasDeal ? discountPct : null,
    ean:         (variant.barcode || '').trim() || null,
    sku:         (variant.sku     || '').trim() || null,
    imageUrl:    raw.images && raw.images[0] ? raw.images[0].src : '',
    productUrl:  `${ORIGIN}/products/${raw.handle}`,
    inStock:     variant.available !== false,
    source:      'lloyds-collection',
    collection:  collectionHandle,
  };
}

// ===== CHANGE DETECTION =====
// Returns { type: 'new'|'priceDrop'|null, product }
// Restocks are silent — cache updated, no Discord post.
function processProduct(p, cache, seenThisRun) {
  seenThisRun.add(p.id);
  const prev = cache.items[p.id];

  if (!prev) {
    cache.items[p.id] = { ...p, status: 'active' };
    return p.wasPrice != null
      ? { type: 'new', product: cache.items[p.id] }
      : { type: null };
  }

  if (prev.status === 'oos') {
    // Restock — silent cache update only
    cache.items[p.id] = { ...prev, ...p, ean: prev.ean || p.ean, status: 'active' };
    return { type: null };
  }

  // Active — refresh display fields, preserve cached EAN
  cache.items[p.id].name     = p.name;
  cache.items[p.id].imageUrl = p.imageUrl;
  cache.items[p.id].brand    = p.brand;
  cache.items[p.id].inStock  = p.inStock;

  if (p.wasPrice == null) {
    cache.items[p.id].price       = p.price;
    cache.items[p.id].wasPrice    = null;
    cache.items[p.id].discountPct = null;
    return { type: null };
  }

  const prevPrice = prev.price;
  if (prevPrice != null && p.price < prevPrice - 0.005) {
    const newPct = Math.round((1 - p.price / prevPrice) * 100);
    cache.items[p.id] = {
      ...prev,
      price:       p.price,
      wasPrice:    prevPrice,
      discountPct: newPct,
      name:        p.name,
      imageUrl:    p.imageUrl,
      brand:       p.brand,
      status:      'active',
    };
    return { type: 'priceDrop', product: cache.items[p.id] };
  }

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
  const titleQ = encodeURIComponent(p.name || '');

  function searchLinks(q) {
    return (
      `[SAS](https://sas.selleramp.com/sas/lookup?sasLookup&search_term=${q})` +
      ` | [Amazon](https://www.amazon.co.uk/s?k=${q})` +
      ` | [eBay Active](https://www.ebay.co.uk/sch/i.html?_nkw=${q})` +
      ` | [eBay Sold](https://www.ebay.co.uk/sch/i.html?_nkw=${q}&LH_Complete=1&LH_Sold=1)`
    );
  }

  return {
    title:     prefix + p.name,
    url:       p.productUrl,
    color:     EMBED_COLOR,
    thumbnail: { url: p.imageUrl },
    fields: [
      { name: '__**Product Details**__', value: quoteLines(detailLines),                                      inline: false },
      { name: '__**Pricing**__',         value: quoteLines(pricingLines),                                     inline: false },
      { name: '🔍 EAN Search',           value: quoteLines([eanQ ? searchLinks(eanQ) : 'EAN not available']), inline: false },
      { name: '🔎 Title Search',         value: quoteLines([searchLinks(titleQ)]),                            inline: false },
    ],
    footer:    { text: FOOTER_TEXT, icon_url: FOOTER_ICON },
    timestamp: new Date().toISOString(),
  };
}

async function postToDiscord(p, type) {
  const webhookUrl  = process.env.LLOYDS_WEBHOOK_URL   || '';
  const webhookUrl2 = process.env.LLOYDS_WEBHOOK_URL_2 || '';
  if (!webhookUrl) { console.warn(`[${STORE_NAME}] No LLOYDS_WEBHOOK_URL — skipping.`); return; }

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
async function scrapeCategory(handle, cache, seenThisRun, coldStart) {
  let totNew = 0, totPriceDrops = 0, pagesScraped = 0, totSeen = 0;

  console.log(`\n[${STORE_NAME}] Scanning: ${handle}${coldStart ? ' (cold start — no posts)' : ''}`);

  for (let pageNum = 1; ; pageNum++) {
    if (pageNum > 1) await sleep(500 + randInt(0, 500));

    const products = await fetchCollectionPage(handle, pageNum);
    if (!products || products.length === 0) {
      if (pageNum === 1) console.warn(`  [${STORE_NAME}] No products for ${handle}`);
      break;
    }

    pagesScraped++;
    const items = products.map(r => parseProduct(r, handle)).filter(Boolean);
    totSeen += items.length;
    console.log(`  [${STORE_NAME}] Page ${pageNum}: ${items.length} products`);

    for (const p of items) {
      const result = processProduct(p, cache, seenThisRun);
      if (result.type === 'new')       totNew++;
      if (result.type === 'priceDrop') totPriceDrops++;
      if (!coldStart && (result.type === 'new' || result.type === 'priceDrop')) {
        await postToDiscord(result.product, result.type);
      }
    }

    saveCache(cache);

    if (products.length < 250) break; // last page — fewer than limit means no more
  }

  return { totNew, totPriceDrops, pagesScraped, seen: totSeen };
}

// ===== MAIN SCAN =====
async function scan() {
  const cache       = loadCache();
  const coldStart   = Object.keys(cache.items).length === 0;
  const seenThisRun = new Set();
  let totNew = 0, totPriceDrops = 0, totPages = 0;
  const categorySummary = [];

  if (coldStart) console.log(`[${STORE_NAME}] Cold start — cache is empty. Populating silently, no Discord posts this run.`);

  async function freshBrowserPage() {
    const b = await launchBrowser();
    const p = await b.newPage();
    await p.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });
    await p.setRequestInterception(true);
    p.on('request', req => {
      BLOCK_RESOURCE_TYPES.has(req.resourceType()) ? req.abort() : req.continue();
    });
    return { browser: b, page: p };
  }

  // 1. Category discovery — dedicated short-lived browser
  let discoveredHandles, newCats, missingCats;
  {
    const { browser: b, page } = await freshBrowserPage();
    try {
      ({ discoveredHandles, newCats, missingCats } = await checkCategories(page));
    } finally {
      await closeBrowser(b);
    }
  }

  const handles = discoveredHandles.map(d => d.handle);
  console.log(`[${STORE_NAME}] Scanning ${handles.length} collections via Shopify API...`);

  // 2. Scrape each collection — pure HTTP, no browser needed
  for (const handle of handles) {
    let result;
    try {
      result = await scrapeCategory(handle, cache, seenThisRun, coldStart);
    } catch (err) {
      console.error(`[${STORE_NAME}] Error on ${handle}:`, err.message);
      categorySummary.push({ label: handle, new: 0, drops: 0, pages: 0, error: true });
      continue;
    }

    totNew        += result.totNew;
    totPriceDrops += result.totPriceDrops;
    totPages      += result.pagesScraped;
    categorySummary.push({
      label: handle,
      new:   result.totNew,
      drops: result.totPriceDrops,
      pages: result.pagesScraped,
      seen:  result.seen,
    });
  }

  // 3. Mark OOS — active items not seen this run
  let totOos = 0;
  if (totPages > 0) {
    for (const id of Object.keys(cache.items)) {
      const it = cache.items[id];
      if (!it || it.source !== 'lloyds-collection') continue;
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
    totRestocks:  0,
    totOos,
    coldStart,
    categorySummary,
    totalCached,
    newCats:     newCats.map(d => ({ name: d.handle })),
    missingCats: missingCats.map(h => ({ name: h })),
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
  const filename = `LloydsScrape-${dateStr}.csv`;
  const filepath  = path.resolve(__dirname, '..', filename);

  try {
    const rootDir = path.resolve(__dirname, '..');
    fs.readdirSync(rootDir)
      .filter(f => f.startsWith('LloydsScrape-') && f.endsWith('.csv') && f !== filename)
      .forEach(f => fs.unlinkSync(path.join(rootDir, f)));
  } catch {}

  const headers = [
    'Image', 'Title', 'Brand', 'EAN', 'SKU', 'Product URL',
    'Now Price', 'Was Price', 'Discount %',
    'SAS', 'Amazon', 'eBay Active', 'eBay Sold',
  ];
  const rows = [headers.map(csvEscape).join(',')];

  for (const item of Object.values(cache.items).filter(it => it.source === 'lloyds-collection')) {
    const enc = encodeURIComponent(item.ean || item.name || '');
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
};
