'use strict';

const fs   = require('fs');
const path = require('path');

// ===== CONFIG =====
const STORE_NAME = 'The Entertainer';
const ORIGIN     = 'https://www.thetoyshop.com';

// Algolia — app ID and search-only API key are public (embedded in page source).
const ALGOLIA_APP_ID  = 'VVR2A7ID9Y';
const ALGOLIA_API_KEY = 'c791b7381385c837ab5f0d0118d53145';
const ALGOLIA_INDEX   = 'prod_thetoyshop_products';
const ALGOLIA_URL     = `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query`;

// BazaarVoice — passkey is public (embedded in page source); used for EAN lookup.
const BV_URL     = 'https://api.bazaarvoice.com/data/products.json';
const BV_PASSKEY = 'carvOMotpKGuLi67I0GAUTSprsNFe2feorXHiJKNkI6B8';
const BV_DISPLAY = '6038-en_gb';

const PAGE_SIZE = 48;

const CATEGORIES = [
  { seoId: 'reduced-to-clear', label: 'Reduced to Clear' },
  { seoId: 'special-offers',   label: 'Special Offers'   },
];

const EMBED_COLOR = 0xE31837; // The Entertainer red
const CACHE_FILE  = path.resolve(__dirname, '..', 'last_seen_entertainer.json');
const LOGO_FILE   = path.resolve(__dirname, '..', 'entertainer.png');
const FOOTER_TEXT = 'Powered by Reseller Hub';
const FOOTER_ICON = 'https://i.imgur.com/aXI4ucP.png';

const MIN_POST_DELAY_MS        = 1500;
const COLD_START_PREVIEW_COUNT = 5;

const DISCOUNT_ROLES = [
  { minPct: 75, roleId: '1482059276397842513' },
  { minPct: 50, roleId: '1482059204255809597' },
  { minPct: 30, roleId: '1482058952257568799' },
];

const ALGOLIA_HEADERS = {
  'x-algolia-application-id': ALGOLIA_APP_ID,
  'x-algolia-api-key':        ALGOLIA_API_KEY,
  'content-type':             'application/json',
  'Accept':                   'application/json',
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
async function fetchCategoryPage(seoId, pageNum) {
  try {
    const res = await fetch(ALGOLIA_URL, {
      method:  'POST',
      headers: ALGOLIA_HEADERS,
      body: JSON.stringify({
        filters:              `seoCategories:"${seoId}"`,
        hitsPerPage:          PAGE_SIZE,
        page:                 pageNum,
        attributesToRetrieve: ['productName','code','price','wasPrice','img_515Wx515H','productURL','brands','stockLevelStatus'],
      }),
    });
    if (!res.ok) {
      console.warn(`[${STORE_NAME}] Algolia ${seoId} p${pageNum}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return {
      products:   data.hits       || [],
      total:      data.nbHits     || 0,
      totalPages: data.nbPages    || 1,
    };
  } catch (e) {
    console.warn(`[${STORE_NAME}] Fetch error ${seoId} p${pageNum}: ${e.message}`);
    return null;
  }
}

// BazaarVoice EAN lookup — one request per product, only when posting to Discord.
async function fetchEan(code) {
  try {
    const res = await fetch(
      `${BV_URL}?resource=products&filter=id%3Aeq%3A${encodeURIComponent(code)}&passkey=${BV_PASSKEY}&apiversion=5.5&displaycode=${BV_DISPLAY}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.Results?.[0]?.EANs?.[0] || null;
  } catch { return null; }
}

// ===== PRODUCT PARSER =====
function parseProduct(raw, categoryLabel) {
  if (!raw?.code) return null;

  const name = (raw.productName || '').trim();
  if (!name) return null;

  const price    = raw.price    != null ? parseFloat(raw.price)    : null;
  const wasPrice = raw.wasPrice != null ? parseFloat(raw.wasPrice) : null;

  if (price == null || isNaN(price)) return null;

  const hasDeal     = wasPrice != null && wasPrice > price + 0.005;
  const discountPct = hasDeal ? Math.round((wasPrice - price) / wasPrice * 100) : null;

  const brand = (raw.brands || []).filter(b => b && b !== 'Search by brand')[0] || '';

  return {
    id:          raw.code,
    name,
    brand,
    price,
    wasPrice:    hasDeal ? wasPrice    : null,
    discountPct: hasDeal ? discountPct : null,
    ean:         null,   // enriched via BazaarVoice before Discord post
    sku:         raw.code,
    imageUrl:    raw.img_515Wx515H ? `${ORIGIN}${raw.img_515Wx515H}` : '',
    productUrl:  raw.productURL    ? `${ORIGIN}${raw.productURL}`    : ORIGIN,
    inStock:     raw.stockLevelStatus === true,
    source:      'entertainer-category',
    collection:  categoryLabel,
  };
}

// Fetch EAN from BazaarVoice just before Discord post.
async function enrichProduct(product) {
  await sleep(300 + randInt(0, 200));
  const ean = await fetchEan(product.sku);
  if (ean) {
    product.ean = ean;
    if (product._cacheRef) product._cacheRef.ean = ean;
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
  const webhookUrl  = process.env.ENTERTAINER_WEBHOOK_URL   || '';
  const webhookUrl2 = process.env.ENTERTAINER_WEBHOOK_URL_2 || '';
  if (!webhookUrl) { console.warn(`[${STORE_NAME}] No ENTERTAINER_WEBHOOK_URL — skipping.`); return; }

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
  const { seoId, label } = cat;
  let totNew = 0, totPriceDrops = 0, pagesScraped = 0, totSeen = 0;
  let totalPages = 1;

  for (let pageNum = 0; pageNum < totalPages; pageNum++) {
    if (pageNum > 0) await sleep(600 + randInt(0, 400));

    const result = await fetchCategoryPage(seoId, pageNum);
    if (!result) {
      if (pageNum === 0) {
        console.warn(`[${STORE_NAME}] No response for ${label}`);
        return { totNew, totPriceDrops, pagesScraped, seen: 0, error: true };
      }
      break;
    }

    if (pageNum === 0) {
      totalPages = result.totalPages;
      console.log(`\n[${STORE_NAME}] ${label}: ${result.total} products, ${totalPages} pages${coldStart ? ` (cold start — ${coldStartBudget.remaining} preview posts remaining)` : ''}`);
    }

    const items = result.products.map(r => parseProduct(r, label)).filter(Boolean);
    totSeen += items.length;
    pagesScraped++;
    console.log(`  [${STORE_NAME}] Page ${pageNum + 1}: ${items.length} products`);

    for (const p of items) {
      const detection = processProduct(p, cache, seenThisRun);
      if (detection.type === 'new')       totNew++;
      if (detection.type === 'priceDrop') totPriceDrops++;

      const shouldPost = !coldStart
        ? (detection.type === 'new' || detection.type === 'priceDrop')
        : (detection.type === 'new' && coldStartBudget.remaining > 0);

      if (shouldPost) {
        detection.product._cacheRef = cache.items[detection.product.id];
        await enrichProduct(detection.product);
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
  const categorySummary = [];
  const coldStartBudget = { remaining: COLD_START_PREVIEW_COUNT };

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

  // Mark OOS — products not seen in this full run have left the sale categories
  let totOos = 0;
  if (totPages > 0) {
    for (const id of Object.keys(cache.items)) {
      const it = cache.items[id];
      if (!it || it.source !== 'entertainer-category') continue;
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
  const filename = `EntertainerScrape-${dateStr}.csv`;
  const filepath  = path.resolve(__dirname, '..', filename);

  try {
    const rootDir = path.resolve(__dirname, '..');
    fs.readdirSync(rootDir)
      .filter(f => f.startsWith('EntertainerScrape-') && f.endsWith('.csv') && f !== filename)
      .forEach(f => fs.unlinkSync(path.join(rootDir, f)));
  } catch {}

  const headers = [
    'Image', 'Title', 'Brand', 'EAN', 'SKU', 'Product URL',
    'Now Price', 'Was Price', 'Discount %',
    'SAS', 'Amazon', 'eBay Active', 'eBay Sold',
  ];
  const rows = [headers.map(csvEscape).join(',')];

  for (const item of Object.values(cache.items).filter(it => it.source === 'entertainer-category')) {
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
