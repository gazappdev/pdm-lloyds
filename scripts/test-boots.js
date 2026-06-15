'use strict';

// Run with: node scripts/test-boots.js  OR  set TEST_BOOTS=1 in Bisect env and restart.
//
// CONFIRMED FINDINGS:
//   Platform: IBM WebSphere Commerce. storeId=11352.
//   Skincare savings category ID: 2608697.
//   API: /search/resources/store/11352/productview/byCategory/2608697?pageSize=24&pageNumber=1&lang=-1
//   466 products, 20 pages.
//   EAN: attributes.find(identifier==="barcode").values[0].value — 100% populated.
//   Prices: Display/L = current sale price, Offer/I = normal/was price.
//   This run: get full single-product JSON to find image URL and product page URL format.

const ORIGIN   = 'https://www.boots.com';
const STORE_ID = '11352';
const SKINCARE_SAVINGS_ID = '2608697';

const JSON_HEADERS = {
  'Accept':          'application/json, */*;q=0.9',
  'Accept-Language': 'en-GB,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Cache-Control':   'no-cache',
};

const hr = () => console.log('─'.repeat(70));

async function get(label, url) {
  hr();
  console.log(`TEST : ${label}`);
  console.log(`URL  : ${url}`);
  try {
    const res = await fetch(url, { headers: JSON_HEADERS, redirect: 'follow' });
    console.log(`Status : ${res.status}`);
    const text = await res.text();
    if (text.includes('reeseSkipExpirationCheck')) { console.log('⚠️  INCAPSULA BLOCKED'); return null; }
    try { return { status: res.status, data: JSON.parse(text), text }; }
    catch { console.log('Not JSON:\n', text.slice(0, 400)); return null; }
  } catch (err) { console.log(`ERROR: ${err.message}`); return null; }
}

(async () => {
  console.log('Boots.com probe — RUN 5 (product image + URL structure)');
  console.log('Date:', new Date().toISOString());

  // ── 1. Full category page 1 — print COMPLETE first product JSON ─────────
  const cat = await get(
    'Full product listing (page 1) — print entire first product entry',
    `${ORIGIN}/search/resources/store/${STORE_ID}/productview/byCategory/${SKINCARE_SAVINGS_ID}?pageSize=5&pageNumber=1&lang=-1`
  );
  if (cat?.data) {
    const items = cat.data.catalogEntryView || [];
    console.log(`\nTotal products: ${cat.data.recordSetTotal}  — Returned: ${items.length}`);
    if (items.length) {
      console.log('\n=== COMPLETE FIRST PRODUCT JSON ===');
      // Print full JSON but exclude the giant attributes list for readability
      const p = { ...items[0] };
      const attrSummary = (p.attributes || []).slice(0, 5).map(a => ({
        id: a.identifier, val: a.values?.[0]?.value
      }));
      delete p.attributes;
      console.log(JSON.stringify(p, null, 2));
      console.log('\n[attributes sample (first 5)]:');
      console.log(JSON.stringify(attrSummary, null, 2));

      // Scan all top-level keys for image/url-like content
      console.log('\n=== Keys containing "image", "img", "url", "seo", "href", "thumb", "photo" ===');
      const raw = JSON.stringify(items[0]);
      const keyMatches = [...raw.matchAll(/"([^"]*(?:image|img|url|seo|href|thumb|photo|fullImage|thumbnail)[^"]*)":/gi)];
      const keys = [...new Set(keyMatches.map(m => m[1]))];
      console.log('Matching keys:', keys.join(', '));

      // Print values for those keys
      for (const key of keys.slice(0, 20)) {
        const re = new RegExp(`"${key}":\\s*"([^"]{5,})"`, 'i');
        const m  = raw.match(re);
        if (m) console.log(`  ${key}: ${m[1].slice(0, 120)}`);
      }
    }
  }

  // ── 2. Single product by uniqueID — often has richer SEO data ──────────
  const single = await get(
    'Single product by uniqueID 11718 (Eucerin foot cream)',
    `${ORIGIN}/search/resources/store/${STORE_ID}/productview/byId/11718?lang=-1`
  );
  if (single?.data) {
    const p = single.data.catalogEntryView?.[0] || single.data;
    console.log('\n=== Single product keys ===');
    console.log(Object.keys(p).join(', '));

    // Look for image and URL fields
    const raw = JSON.stringify(p);
    const imgMatch = raw.match(/"(?:fullImage|thumbnail|mediumImage|largeImage)":\s*"([^"]+)"/);
    if (imgMatch) console.log('\nImage field found:', imgMatch[0]);
    const seoMatch = raw.match(/"(?:seo|href|seoUrl|productUrl|slug)":\s*\{?([^}]{0,200})/);
    if (seoMatch) console.log('\nSEO/URL field found:', seoMatch[0]);
    console.log('\nFull single product (first 4000 chars):\n', raw.slice(0, 4000));
  }

  // ── 3. WCS classic byId — sometimes has image/URL not in search endpoint
  const wcs = await get(
    'WCS classic productview byId 11718',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/productview/byId/11718?langId=-1&currency=GBP`
  );
  if (wcs?.data) {
    const raw = JSON.stringify(wcs.data);
    console.log('\nWCS byId — All keys in first CatalogEntryView:');
    const p = wcs.data.CatalogEntryView?.[0];
    if (p) {
      console.log(Object.keys(p).join(', '));
      const imgMatch = raw.match(/"(?:fullImage|thumbnail|mediumImage|attachments|Images)"[^:]*:[^{]*(\{[^}]+\}|"[^"]+")/g);
      if (imgMatch) console.log('\nImage-like fields:', imgMatch.slice(0, 5).join('\n'));
      console.log('\nFull WCS product (first 4000 chars):\n', raw.slice(0, 4000));
    }
  }

  // ── 4. Verify price ordering across more products ───────────────────────
  hr();
  console.log('Price ordering check across all 5 products from page 1:');
  if (cat?.data) {
    const items = cat.data.catalogEntryView || [];
    for (const p of items) {
      const display = p.price?.find(x => x.usage === 'Display')?.value;
      const offer   = p.price?.find(x => x.usage === 'Offer')?.value;
      const d = parseFloat(display || '0');
      const o = parseFloat(offer   || '0');
      const label = d < o ? 'Display < Offer (Display=CURRENT, Offer=WAS) ✅' : d > o ? 'Display > Offer ⚠️' : 'EQUAL';
      console.log(`  ${p.name.slice(0, 50).padEnd(50)} Display:£${(display||'?').padStart(6)} Offer:£${(offer||'?').padStart(6)} → ${label}`);
    }
  }

  hr();
  console.log('PROBE COMPLETE');
  process.exit(0);
})();
