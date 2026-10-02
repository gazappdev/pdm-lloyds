'use strict';

const fs   = require('fs');
const path = require('path');

// ===== CONFIG =====
const STORE_NAME  = 'Home Bargains';
const EMBED_COLOR = 0x9FDDF9;

const CACHE_FILE      = path.resolve(__dirname, '..', 'last_seen_homebargains.json');
const URLS_FILE       = path.resolve(__dirname, '..', 'homebargains_urls.json');
const LOGO_FILE       = path.resolve(__dirname, '..', 'homebargains.png');
const IGNORELIST_FILE = path.resolve(__dirname, '..', 'homebargains_ignored.json');

const MIN_POST_DELAY_MS = 1200;
const FOOTER_TEXT = 'Powered by Reseller Hub';
const FOOTER_ICON = 'https://i.imgur.com/aXI4ucP.png';

const DISCOUNT_ROLES = [
  { minPct: 75, roleId: '1482059276397842513' },
  { minPct: 50, roleId: '1482059204255809597' },
  { minPct: 30, roleId: '1482058952257568799' },
];

// ===== HELPERS =====
const sleep = ms => new Promise(r => setTimeout(r, ms));

function labelFromUrl(url) {
  const match = url.match(/\/category\/\d+\/([^?#]+)/);
  if (!match) return url;
  return match[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ===== IGNORELIST =====
function loadIgnorelist() {
  try {
    if (!fs.existsSync(IGNORELIST_FILE)) {
      fs.writeFileSync(IGNORELIST_FILE, JSON.stringify([], null, 2));
      return new Set();
    }
    const raw = JSON.parse(fs.readFileSync(IGNORELIST_FILE, 'utf8'));
    if (!Array.isArray(raw)) return new Set();
    if (raw.length) console.log(`[${STORE_NAME}] Ignorelist: ${raw.length} suppressed product(s)`);
    return new Set(raw);
  } catch (err) {
    console.warn(`[${STORE_NAME}] Could not load ignorelist: ${err.message}`);
    return new Set();
  }
}

// ===== CACHE =====
if (!fs.existsSync(CACHE_FILE)) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ items: {} }, null, 2));
}

function loadCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!parsed.items || typeof parsed.items !== 'object') parsed.items = {};
    for (const entry of Object.values(parsed.items)) {
      if (!Array.isArray(entry.urls)) entry.urls = [];
      if (!entry.status) entry.status = 'active';
      if (entry.price    != null) entry.price    = Math.round(parseFloat(entry.price)    * 100) / 100;
      if (entry.wasPrice != null) entry.wasPrice = Math.round(parseFloat(entry.wasPrice) * 100) / 100;
    }
    return parsed;
  } catch { return { items: {} }; }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ===== URLS =====
function loadUrls() {
  try {
    const arr = JSON.parse(fs.readFileSync(URLS_FILE, 'utf8').trim());
    return Array.isArray(arr) ? arr.map(u => String(u).trim()).filter(Boolean) : [];
  } catch {
    return fs.readFileSync(URLS_FILE, 'utf8')
      .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  }
}

// ===== FETCH =====
async function fetchCategory(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
  });

  const html = await res.text();
  const startIndex = html.indexOf('"productData":');
  if (startIndex === -1) { console.warn(`[${STORE_NAME}] No productData in ${url}`); return []; }

  const arrayStart = html.indexOf('[', startIndex);
  if (arrayStart === -1) return [];

  let depth = 0, arrayEnd = -1;
  for (let i = arrayStart; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { arrayEnd = i; break; } }
  }
  if (arrayEnd === -1) return [];

  try {
    const parsed = JSON.parse(
      html.slice(arrayStart, arrayEnd + 1).replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')
    );
    const products = Array.isArray(parsed) ? parsed : (parsed.products || []);
    console.log(`[${STORE_NAME}] Fetched ${products.length} products from ${url}`);
    return products;
  } catch (e) {
    console.warn(`[${STORE_NAME}] JSON parse failed for ${url}: ${e.message}`);
    return [];
  }
}

// ===== PRODUCT MAPPER =====
function mapProduct(p, url) {
  const variant      = p.variants?.[0] || {};
  const cost         = p.cost || variant.cost || {};
  const restrictions = variant.restrictions || {};

  let displayCode = 'N/A';
  if (p.images?.[0]?.id) {
    const match = p.images[0].id.match(/^(\d+)[_\-](\d+)/);
    displayCode = match ? `P${match[1]}-A${match[2]}` : p.images[0].id;
  }

  const price       = cost.price ? Math.round(cost.price) / 100 : null;
  const wasPrice    = cost.rrp   ? Math.round(cost.rrp)   / 100 : null;
  const discountPct = wasPrice && price && wasPrice > price
    ? Math.round(((wasPrice - price) / wasPrice) * 100) : null;

  return {
    cacheKey:    p.id,
    productCode: displayCode,
    name:        p.displayName,
    price,
    wasPrice,
    discountPct,
    maxQty:      restrictions.maxSaleQty || 1,
    thumb:       p.images?.[0]?.srcMain ? `https://media.home.bargains${p.images[0].srcMain}` : null,
    url:         `https://home.bargains/product/${p.id}/${p.slug}`,
    sourceUrl:   url,
  };
}

// ===== DISCORD =====
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

function buildEmbed(p, type) {
  const prefix = type === 'new' ? '🆕' : '📉';
  const pricingLines = [`Now: £${p.price.toFixed(2)}`];
  if (p.wasPrice)    pricingLines.push(`Was: £${p.wasPrice.toFixed(2)}`);
  if (p.discountPct) pricingLines.push(`Discount: ${p.discountPct}%`);

  const detailLines = [`Product ID: \`${p.productCode || 'N/A'}\``];
  if (p.maxQty) detailLines.push(`Order Limit / Total Stock: ${p.maxQty}`);

  const enc = encodeURIComponent(capSearchQuery(p.name || ''));
  const searchLinks = [
    `[SAS](https://sas.selleramp.com/sas/lookup?sasLookup&search_term=${enc})`,
    `[Amazon](https://www.amazon.co.uk/s?k=${enc})`,
    `[eBay Active](https://www.ebay.co.uk/sch/i.html?_nkw=${enc})`,
    `[eBay Sold](https://www.ebay.co.uk/sch/i.html?_nkw=${enc}&LH_Complete=1&LH_Sold=1)`,
  ].join(' | ');

  return {
    title:     `${prefix} ${p.name}`,
    url:       p.url,
    color:     EMBED_COLOR,
    thumbnail: p.thumb ? { url: p.thumb } : undefined,
    fields: [
      { name: '**Product Details**', value: `> ${detailLines.join('\n> ')}`, inline: false },
      { name: '**Pricing**',         value: `> ${pricingLines.join('\n> ')}`, inline: false },
      { name: '🔍 **Title Search**', value: `> ${searchLinks}`,              inline: false },
    ],
    footer:    { text: FOOTER_TEXT, icon_url: FOOTER_ICON },
    timestamp: new Date().toISOString(),
  };
}

async function postToDiscord(p, type) {
  const webhookUrl  = process.env.HB_WEBHOOK_URL   || '';
  const webhookUrl2 = process.env.HB_WEBHOOK_URL_2 || '';
  if (!webhookUrl) { console.warn(`[${STORE_NAME}] No HB_WEBHOOK_URL — skipping.`); return; }

  const embed = buildEmbed(p, type);

  let roleMention = null;
  if (p.discountPct) {
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
    if (webhookUrl2) postToUrl(webhookUrl2).catch(err => console.warn(`[${STORE_NAME}] Webhook 2 error: ${err.message}`));
  } else {
    console.error(`[${STORE_NAME}] Discord post failed: ${res.status}`);
  }

  const legoWebhook = process.env.HB_LEGO_WEBHOOK_URL || '';
  if (legoWebhook && type === 'priceDrop' && p.name.toLowerCase().includes('lego')) {
    const legoRes = await sendWebhookJSON(legoWebhook, { embeds: [embed] });
    if (legoRes.ok) console.log(`[${STORE_NAME}] Mirrored LEGO price drop`);
  }
}

// ===== MAIN SCAN =====
async function scan() {
  const cache       = loadCache();
  const ignorelist  = loadIgnorelist();
  const urls        = loadUrls();
  const seenThisRun = new Set();

  console.log(`[${STORE_NAME}] Scanning ${urls.length} URL(s)...`);

  let totNew = 0, totPriceDrops = 0, totRestocks = 0, totOos = 0, totIgnored = 0, totPages = 0;
  const postQueue       = [];
  const categorySummary = [];

  for (const url of urls) {
    const label = labelFromUrl(url);
    console.log(`\n[${STORE_NAME}] Checking: ${label}`);

    let products;
    try {
      products = await fetchCategory(url);
    } catch (err) {
      console.error(`[${STORE_NAME}] Fetch failed for ${url}: ${err.message}`);
      categorySummary.push({ label, new: 0, drops: 0, restocks: 0, pages: 0, seen: 0, error: true });
      continue;
    }

    if (products.length === 0) {
      categorySummary.push({ label, new: 0, drops: 0, restocks: 0, pages: 0, seen: 0, error: false });
      continue;
    }

    totPages++;
    let catNew = 0, catDrops = 0, catRestocks = 0;

    for (const raw of products) {
      const p   = mapProduct(raw, url);
      const key = p.cacheKey;
      seenThisRun.add(key);

      if (ignorelist.has(p.productCode)) {
        const prev = cache.items[key];
        cache.items[key] = prev
          ? { ...prev, ...p, status: 'active' }
          : { ...p, status: 'active', urls: [url] };
        totIgnored++;
        continue;
      }

      const prev = cache.items[key];

      if (!prev) {
        cache.items[key] = { ...p, status: 'active', urls: [url] };
        postQueue.push({ p: { ...p }, type: 'new' });
        catNew++;
        totNew++;

      } else if (prev.status === 'oos') {
        const oldPrice = prev.price;
        const newPrice = p.price;
        cache.items[key] = { ...prev, ...p, status: 'active', urls: prev.urls || [url] };

        if (oldPrice != null && newPrice != null && newPrice < oldPrice - 0.005) {
          postQueue.push({ p: { ...cache.items[key] }, type: 'priceDrop' });
          catDrops++;
          totPriceDrops++;
        } else if (oldPrice != null && newPrice != null && newPrice > oldPrice + 0.005) {
          console.log(`[${STORE_NAME}] OOS→active higher price (silent): ${p.name}`);
        } else {
          catRestocks++;
          totRestocks++;
        }

      } else if (prev.price != null && p.price != null && p.price < prev.price - 0.005) {
        cache.items[key] = { ...prev, ...p, status: 'active' };
        postQueue.push({ p: { ...cache.items[key] }, type: 'priceDrop' });
        catDrops++;
        totPriceDrops++;

      } else {
        cache.items[key] = { ...prev, ...p, status: 'active' };
      }
    }

    saveCache(cache);
    categorySummary.push({ label, new: catNew, drops: catDrops, restocks: catRestocks, pages: 1, seen: products.length });
  }

  // Mark OOS — only after all URLs are processed
  for (const key of Object.keys(cache.items)) {
    const it = cache.items[key];
    if (!seenThisRun.has(key) && it.status !== 'oos') {
      cache.items[key].status = 'oos';
      totOos++;
      console.log(`[${STORE_NAME}] OOS: ${it.name || key}`);
    }
  }
  saveCache(cache);

  if (totIgnored) console.log(`[${STORE_NAME}] ${totIgnored} ignored product(s) suppressed`);

  // Post to Discord after all cache saves are done
  for (const { p, type } of postQueue) await postToDiscord(p, type);

  const totalCached = Object.keys(cache.items).length;
  console.log(`[${STORE_NAME}] Done. Cached: ${totalCached}. New: ${totNew}  Drops: ${totPriceDrops}  OOS: ${totOos}`);

  return {
    storeName:            STORE_NAME,
    color:                EMBED_COLOR,
    logoFile:             LOGO_FILE,
    uniqueSeen:           seenThisRun.size,
    pagesScraped:         totPages,
    totNew,
    totPriceDrops,
    totRestocks,
    totOos,
    coldStart:            false,
    coldStartPreviewSent: 0,
    categorySummary,
    totalCached,
    newCats:              [],
    missingCats:          [],
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
  const filename = `HomeBargainsScrape-${dateStr}.csv`;
  const filepath  = path.resolve(__dirname, '..', filename);

  try {
    const rootDir = path.resolve(__dirname, '..');
    fs.readdirSync(rootDir)
      .filter(f => f.startsWith('HomeBargainsScrape-') && f.endsWith('.csv') && f !== filename)
      .forEach(f => fs.unlinkSync(path.join(rootDir, f)));
  } catch {}

  const headers = [
    'Image', 'Product ID', 'Title', 'Product URL',
    'Now Price', 'Was Price', 'Discount %', 'Max Qty',
    'SAS', 'Amazon', 'eBay Active', 'eBay Sold',
  ];
  const rows = [headers.map(csvEscape).join(',')];

  for (const item of Object.values(cache.items).filter(it => it.status === 'active')) {
    const enc = encodeURIComponent(capSearchQuery(item.name || ''));
    rows.push([
      item.thumb       ? `=IMAGE("${item.thumb}")` : '',
      item.productCode || 'N/A',
      item.name        || '',
      item.url         || '',
      item.price    != null ? `£${item.price.toFixed(2)}`    : 'N/A',
      item.wasPrice != null ? `£${item.wasPrice.toFixed(2)}` : '',
      item.discountPct != null ? `${item.discountPct}%`      : '',
      item.maxQty ?? '',
      `https://sas.selleramp.com/sas/lookup?sasLookup&search_term=${enc}`,
      `https://www.amazon.co.uk/s?k=${enc}`,
      `https://www.ebay.co.uk/sch/i.html?_nkw=${enc}`,
      `https://www.ebay.co.uk/sch/i.html?_nkw=${enc}&LH_Complete=1&LH_Sold=1`,
    ].map(csvEscape).join(','));
  }

  fs.writeFileSync(filepath, '﻿' + rows.join('\r\n'), 'utf8');
  console.log(`[${STORE_NAME}] CSV exported: ${filename} (${rows.length - 1} products)`);

  const webhook = scrapesheetWebhook || '';
  if (!webhook) { console.warn(`[${STORE_NAME}] No scrapesheet webhook — skipping.`); return; }

  for (const wh of [webhook, scrapesheetWebhook2].filter(Boolean)) {
    try {
      const buf  = fs.readFileSync(filepath);
      const form = new FormData();
      form.append('files[0]', new Blob([buf], { type: 'text/csv' }), filename);
      await fetch(wh, { method: 'POST', body: form });
    } catch (err) { console.error(`[${STORE_NAME}] CSV post error: ${err.message}`); }
  }
  console.log(`[${STORE_NAME}] CSV posted to scrapesheet.`);
}

module.exports = {
  config: { name: STORE_NAME },
  scan,
  exportCSV,
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
