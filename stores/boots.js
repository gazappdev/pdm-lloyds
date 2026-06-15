'use strict';

const fs   = require('fs');
const path = require('path');

// ===== CONFIG =====
const STORE_NAME = 'Boots';
const ORIGIN     = 'https://www.boots.com';
const STORE_ID   = '11352';
const PAGE_SIZE  = 24;

// Numeric category IDs — text identifiers are blocked by Incapsula; numeric IDs bypass it.
// To add more categories: run node scripts/test-boots.js (TEST_BOOTS=1 on Bisect) and drill the tree.
const CATEGORIES = [
  { id: '2608697', label: 'Skincare Savings' },
];

const EMBED_COLOR = 0x001489; // Boots blue
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
function parseProduct(raw, categoryLabel) {
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
    source:      'boots-category',
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

    // Image: thumbnail field (may be null in WCS; fall back to constructed path)
    const thumb = detail.thumbnail;
    if (thumb && !thumb.includes('null') && !thumb.includes('not defined')) {
      product.imageUrl = thumb.startsWith('http') ? thumb : `${ORIGIN}${thumb}`;
    } else {
      product.imageUrl = `${ORIGIN}/wcsstore/eBootsStorefrontAssetStore/images/catalog/${product.partNum}_ms.jpg`;
    }
  } else {
    product.productUrl = `${ORIGIN}/search?q=${encodeURIComponent(product.partNum)}`;
    product.imageUrl   = `${ORIGIN}/wcsstore/eBootsStorefrontAssetStore/images/catalog/${product.partNum}_ms.jpg`;
  }
}

// ===== CHANGE DETECTION =====
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
    cache.items[p.id] = { ...prev, ...p, ean: prev.ean || p.ean, status: 'active' };
    return { type: null };
  }

  cache.items[p.id].name    = p.name;
  cache.items[p.id].brand   = p.brand;
  cache.items[p.id].inStock = p.inStock;

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
async function scrapeCategory(cat, cache, seenThisRun, coldStart, coldStartBudget) {
  const { id, label } = cat;
  let totNew = 0, totPriceDrops = 0, pagesScraped = 0, totSeen = 0;
  let totalPages = 1;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    if (pageNum > 1) await sleep(600 + randInt(0, 400));

    const result = await fetchCategoryPage(id, pageNum);
    if (!result) {
      if (pageNum === 1) {
        console.warn(`[${STORE_NAME}] No response for ${label}`);
        return { totNew, totPriceDrops, pagesScraped, seen: 0, error: true };
      }
      break;
    }

    if (pageNum === 1) {
      totalPages = Math.ceil(result.total / PAGE_SIZE);
      console.log(`\n[${STORE_NAME}] ${label}: ${result.total} products, ${totalPages} pages${coldStart ? ` (cold start — ${coldStartBudget.remaining} preview posts remaining)` : ''}`);
    }

    const items = result.products.map(r => parseProduct(r, label)).filter(Boolean);
    totSeen += items.length;
    pagesScraped++;
    console.log(`  [${STORE_NAME}] Page ${pageNum}: ${items.length} products`);

    for (const p of items) {
      const detection = processProduct(p, cache, seenThisRun);
      if (detection.type === 'new')       totNew++;
      if (detection.type === 'priceDrop') totPriceDrops++;

      const shouldPost = !coldStart
        ? (detection.type === 'new' || detection.type === 'priceDrop')
        : (detection.type === 'new' && coldStartBudget.remaining > 0);

      if (shouldPost) {
        await enrichProduct(detection.product);
        // Persist enriched URLs to cache
        if (cache.items[detection.product.id]) {
          cache.items[detection.product.id].productUrl = detection.product.productUrl;
          cache.items[detection.product.id].imageUrl   = detection.product.imageUrl;
        }
        await postToDiscord(detection.product, detection.type);
        if (coldStart) coldStartBudget.remaining--;
      }
    }
    saveCache(cache);
  }

  return { totNew, totPriceDrops, pagesScraped, seen: totSeen };
}

// ===== MAIN SCAN =====
async function scan() {
  const cache       = loadCache();
  const coldStart   = Object.keys(cache.items).length === 0;
  const seenThisRun = new Set();
  let totNew = 0, totPriceDrops = 0, totPages = 0;
  const categorySummary  = [];
  const coldStartBudget  = { remaining: COLD_START_PREVIEW_COUNT };

  if (coldStart) console.log(`[${STORE_NAME}] Cold start — posting first ${COLD_START_PREVIEW_COUNT} deals for verification, caching rest silently.`);

  for (const cat of CATEGORIES) {
    let result;
    try {
      result = await scrapeCategory(cat, cache, seenThisRun, coldStart, coldStartBudget);
    } catch (err) {
      console.error(`[${STORE_NAME}] Error on ${cat.label}:`, err.message);
      categorySummary.push({ label: cat.label, new: 0, drops: 0, pages: 0, error: true });
      continue;
    }
    totNew        += result.totNew;
    totPriceDrops += result.totPriceDrops;
    totPages      += result.pagesScraped;
    categorySummary.push({
      label: cat.label,
      new:   result.totNew,
      drops: result.totPriceDrops,
      pages: result.pagesScraped,
      seen:  result.seen,
      error: result.error || false,
    });
  }

  // Mark OOS
  let totOos = 0;
  if (totPages > 0) {
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
    totRestocks:  0,
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

  for (const item of Object.values(cache.items).filter(it => it.source === 'boots-category')) {
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
