'use strict';

const fs   = require('fs');
const path = require('path');

// ===== CONFIG =====
const STORE_NAME = 'Toytown';
const ORIGIN     = 'https://www.toytownstores.com';

const PAGE_DELAY_MS        = 900;
const PRODUCT_DELAY_MS     = 500;
const MIN_POST_DELAY_MS    = 1500;
const COLD_START_PREVIEW_COUNT = 5;

const EMBED_COLOR = 0x3078C0; // Toytown blue (site primary / button colour)
const CACHE_FILE  = path.resolve(__dirname, '..', 'last_seen_toytown.json');
const LOGO_FILE   = path.resolve(__dirname, '..', 'toytown.jpg');
const FOOTER_TEXT = 'Powered by Reseller Hub';
const FOOTER_ICON = 'https://i.imgur.com/aXI4ucP.png';

const DISCOUNT_ROLES = [
  { minPct: 75, roleId: '1482059276397842513' },
  { minPct: 50, roleId: '1482059204255809597' },
  { minPct: 30, roleId: '1482058952257568799' },
];

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

function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// ===== HTML FETCHER =====
async function fetchHtml(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Cache-Control':   'no-cache',
      },
    });
    if (!res.ok) {
      console.warn(`[${STORE_NAME}] HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(`[${STORE_NAME}] Fetch error for ${url}: ${e.message}`);
    return null;
  }
}

// ===== LISTING PAGE PARSER =====
// Visualsoft HTML structure:
//   <div class="product product--N parent_product_id_XXXX" data-productreference="SKU">
//     <div class="product__image"><a href="/cat-cN/.../name-pID" title="Product Name">
//       <img src="/images/name-pID-IMGID_thumb.jpg">
//     </div>
//     <div class="product__details__title product__details__title--branded">
//       <a href="..." title="BRAND  FULL NAME" class="infclick">
//         <span>BRAND</span>
//         PRODUCT NAME
//       </a>
//     </div>
//     <div class="product__details__prices">
//       <span class="...price--sale">...<span class="GBP">£20.00</span>...
//       <span class="...prices__was">...<span class="GBP">£40.00</span>...
//
function parseSalePage(html) {
  if (!html) return [];
  const products = [];

  const segments = html.split(/(?=<div class="product product--)/);

  for (const seg of segments) {
    const idMatch = seg.match(/parent_product_id_(\d+)/);
    if (!idMatch) continue;
    const id = idMatch[1];

    // Product URL (first -pNNNN href)
    const urlMatch = seg.match(/href="(\/[^"]+\-p\d+)"/);
    if (!urlMatch) continue;
    const productUrl = ORIGIN + urlMatch[1];

    // Thumbnail — raw HTML uses a 1×1 GIF in src (lazy-load placeholder); real path is in data-src
    const imgMatch = seg.match(/data-src="(\/images\/[^"]+_thumb\.jpg)"/);
    const imageUrl  = imgMatch ? ORIGIN + imgMatch[1].replace('_thumb.jpg', '_medium.jpg') : null;

    // Vendor reference (data-productreference) — overwritten by JSON-LD SKU on enrichment
    const skuMatch = seg.match(/data-productreference="([^"]+)"/);
    const sku = skuMatch ? skuMatch[1] : '';

    // Brand + name from the product__details__title section.
    // Window must be wide enough for long product URL slugs — the </a> can sit 700+ chars in.
    const detailsIdx = seg.indexOf('product__details__title');
    if (detailsIdx === -1) continue;
    const detailsSeg = seg.slice(detailsIdx, detailsIdx + 1500);

    let brand = '';
    let name  = '';
    // Branded products: <span>BRAND</span> followed by NAME text node, both inside the link
    const spanMatch = detailsSeg.match(/<span>\s*([\s\S]+?)\s*<\/span>([\s\S]+?)<\/a>/);
    if (spanMatch) {
      brand = stripHtml(spanMatch[1]).trim();
      name  = stripHtml(spanMatch[2]).trim();
    } else {
      // Non-branded: fall back to the link's title attribute (product name only, no brand prefix)
      const titleMatch = detailsSeg.match(/title="([^"]+)"/);
      name = titleMatch ? stripHtml(titleMatch[1]).trim() : '';
    }
    if (!name) continue;

    // Now price — first product-content__price--inc GBP value in the prices block.
    // Works for both sale items (prices__price--sale) and full-price items.
    // Server HTML puts class="GBP" and its closing > on separate lines, hence \s* between them.
    const priceBlockIdx = seg.indexOf('product__details__prices');
    if (priceBlockIdx === -1) continue;
    const priceBlock = seg.slice(priceBlockIdx, priceBlockIdx + 2000);
    const nowMatch = priceBlock.match(/product-content__price--inc[\s\S]+?class="GBP"\s*>\s*£([\d.]+)/);
    if (!nowMatch) continue;
    const price = parseFloat(nowMatch[1]);
    if (isNaN(price)) continue;

    // Was price — only present when item is on sale (prices__was section)
    const wasMatch = priceBlock.match(/prices__was[\s\S]+?product-content__price--inc[\s\S]+?class="GBP"\s*>\s*£([\d.]+)/);
    const wasPrice = wasMatch ? parseFloat(wasMatch[1]) : null;

    const hasDeal     = wasPrice != null && wasPrice > price + 0.005;
    const discountPct = hasDeal ? Math.round((wasPrice - price) / wasPrice * 100) : null;

    products.push({
      id, name, brand, sku, price,
      wasPrice:    hasDeal ? wasPrice    : null,
      discountPct: hasDeal ? discountPct : null,
      imageUrl, productUrl,
      ean:    null,
      inStock: true,
      source: 'toytown-all',
      collection: 'All Products',
    });
  }

  return products;
}

// ===== PRODUCT PAGE ENRICHMENT (EAN from JSON-LD) =====
async function enrichProduct(product) {
  await sleep(PRODUCT_DELAY_MS + randInt(0, 200));
  const html = await fetchHtml(product.productUrl);
  if (!html) return;

  const ldMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/i);
  if (!ldMatch) return;

  let ld;
  try { ld = JSON.parse(ldMatch[1]); } catch { return; }

  if (ld.gtin13)             product.ean    = ld.gtin13;
  if (ld.SKU)                product.sku    = ld.SKU;
  if (ld.Offers?.availability) {
    product.inStock = ld.Offers.availability.includes('InStock');
  }
}

// ===== CHANGE DETECTION =====
function processProduct(p, cache, seenThisRun) {
  seenThisRun.add(p.id);
  const prev = cache.items[p.id];

  if (!prev) {
    cache.items[p.id] = { ...p, status: 'active' };
    return { type: 'new', product: cache.items[p.id] };
  }

  if (prev.status === 'oos') {
    cache.items[p.id] = { ...prev, ...p, ean: prev.ean || p.ean, status: 'active' };
    return { type: 'restock', product: cache.items[p.id] };
  }

  cache.items[p.id].name    = p.name;
  cache.items[p.id].brand   = p.brand;
  cache.items[p.id].inStock = p.inStock;

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
  const prefix = type === 'priceDrop' ? '📉 ' : '🆕 ';

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
  const webhookUrl  = process.env.TOYTOWN_WEBHOOK_URL   || '';
  const webhookUrl2 = process.env.TOYTOWN_WEBHOOK_URL_2 || '';
  if (!webhookUrl) { console.warn(`[${STORE_NAME}] No TOYTOWN_WEBHOOK_URL — skipping.`); return; }

  const embed = makeEmbed(p, type);

  // Download image in-process so Toytown's CDN cannot block Discord's proxy
  let imageBuffer = null;
  if (p.imageUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const imgRes = await fetch(p.imageUrl, { signal: controller.signal }).finally(() => clearTimeout(timer));
      if (imgRes.ok) {
        imageBuffer = Buffer.from(await imgRes.arrayBuffer());
        embed.thumbnail = { url: 'attachment://product.jpg' };
        console.log(`[${STORE_NAME}] Image downloaded for ${p.id}: ${imageBuffer.length} bytes`);
      } else {
        console.warn(`[${STORE_NAME}] Image download failed for ${p.id}: HTTP ${imgRes.status}`);
      }
    } catch (e) {
      console.warn(`[${STORE_NAME}] Image download error for ${p.id}: ${e.message}`);
    }
  }

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
    if (imageBuffer) {
      await enforcePostSpacing();
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ embeds: [embed] }));
      form.append('files[0]', new Blob([imageBuffer], { type: 'image/jpeg' }), 'product.jpg');
      return fetch(url, { method: 'POST', body: form });
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

// ===== MAIN SCAN =====
async function scan() {
  const cache       = loadCache();
  const coldStart   = Object.keys(cache.items).length === 0;
  const seenThisRun = new Set();
  let totNew = 0, totPriceDrops = 0, totRestocks = 0, totPages = 0, totSeen = 0;
  const coldStartBudget    = { remaining: COLD_START_PREVIEW_COUNT };
  let paginationComplete   = false;

  if (coldStart) console.log(`[${STORE_NAME}] Cold start — posting first ${COLD_START_PREVIEW_COUNT} deals for verification, caching rest silently.`);
  console.log(`\n[${STORE_NAME}] Starting all-products scan...`);

  // Fetch page 1 first to discover total page count from pagination ("Page 1 Of N")
  const page1Html = await fetchHtml(`${ORIGIN}/search/all-products`);
  if (!page1Html) {
    console.error(`[${STORE_NAME}] Failed to fetch page 1 — aborting scan.`);
    return {
      storeName: STORE_NAME, color: EMBED_COLOR, logoFile: LOGO_FILE,
      uniqueSeen: 0, pagesScraped: 0, totNew: 0, totPriceDrops: 0,
      totRestocks: 0, totOos: 0, coldStart, coldStartPreviewSent: 0,
      categorySummary: [{ label: 'All Products', new: 0, drops: 0, restocks: 0, pages: 0, seen: 0, error: true }],
      totalCached: Object.keys(cache.items).length, newCats: [], missingCats: [],
    };
  }

  const pageCountMatch = page1Html.match(/Page\s+\d+\s+Of\s+(\d+)/i);
  const maxPages = pageCountMatch ? parseInt(pageCountMatch[1]) : 999;
  console.log(`[${STORE_NAME}] Total pages: ${maxPages}`);

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    if (pageNum > 1) await sleep(PAGE_DELAY_MS + randInt(0, 400));

    const html = pageNum === 1 ? page1Html : await fetchHtml(`${ORIGIN}/search/all-products?page=${pageNum}`);

    if (!html) {
      console.warn(`[${STORE_NAME}] Page ${pageNum} fetch failed — stopping pagination early.`);
      break;
    }

    const products = parseSalePage(html);
    if (products.length === 0) {
      paginationComplete = true;
      console.log(`[${STORE_NAME}] Page ${pageNum}: no products — stopping early.`);
      break;
    }

    console.log(`[${STORE_NAME}] Page ${pageNum}/${maxPages}: ${products.length} products`);
    totPages++;
    totSeen += products.length;

    for (const p of products) {
      const detection = processProduct(p, cache, seenThisRun);
      if (detection.type === 'new')       totNew++;
      if (detection.type === 'priceDrop') totPriceDrops++;
      if (detection.type === 'restock')   totRestocks++;

      const shouldPost = !coldStart
        ? (detection.type === 'new' || detection.type === 'priceDrop')
        : (detection.type === 'new' && coldStartBudget.remaining > 0);

      if (shouldPost) {
        await enrichProduct(detection.product);
        await postToDiscord(detection.product, detection.type);
        if (coldStart) coldStartBudget.remaining--;
      }
    }

    saveCache(cache);
    if (pageNum === maxPages) paginationComplete = true;
  }

  // Mark OOS only when we successfully scraped all pages (avoid false OOS on partial runs)
  let totOos = 0;
  if (totPages > 0 && paginationComplete) {
    for (const id of Object.keys(cache.items)) {
      const it = cache.items[id];
      if (!it || (it.source !== 'toytown-all' && it.source !== 'toytown-sale')) continue;
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
  console.log(`\n[${STORE_NAME}] Done. Cached: ${totalCached}. New: ${totNew}  Drops: ${totPriceDrops}  Restocks: ${totRestocks}  OOS: ${totOos}`);

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
    categorySummary: [], // single category — totals shown in main stats, no breakdown needed
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
  const filename = `ToytownScrape-${dateStr}.csv`;
  const filepath  = path.resolve(__dirname, '..', filename);

  try {
    const rootDir = path.resolve(__dirname, '..');
    fs.readdirSync(rootDir)
      .filter(f => f.startsWith('ToytownScrape-') && f.endsWith('.csv') && f !== filename)
      .forEach(f => fs.unlinkSync(path.join(rootDir, f)));
  } catch {}

  const headers = [
    'Image', 'Title', 'Brand', 'EAN', 'SKU', 'Product URL',
    'Now Price', 'Was Price', 'Discount %',
    'SAS', 'Amazon', 'eBay Active', 'eBay Sold',
  ];
  const rows = [headers.map(csvEscape).join(',')];

  for (const item of Object.values(cache.items).filter(it => it.source === 'toytown-all' || it.source === 'toytown-sale')) {
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
