'use strict';

// Run with: TEST_BOOTS=1 on Bisect.
// Purpose: find the correct product image URL for Boots WCS products.
// All other API structure confirmed in runs 1-5.

const ORIGIN   = 'https://www.boots.com';
const STORE_ID = '11352';

// Known products from run 4/5 — Eucerin foot cream
const TEST_UNIQUE_ID  = '11718';
const TEST_SKU_ID     = '11719'; // singleSKUCatalogEntryID from run 5
const TEST_PART_NUM   = '10033393';

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
    if (text.includes('reeseSkipExpirationCheck')) { console.log('⚠️  INCAPSULA'); return null; }
    try { return { data: JSON.parse(text), text }; }
    catch { console.log('Not JSON. First 300:\n', text.slice(0, 300)); return null; }
  } catch (err) { console.log(`ERROR: ${err.message}`); return null; }
}

function findImageValues(obj, depth = 0, results = []) {
  if (depth > 8 || !obj) return results;
  if (typeof obj === 'string') {
    if (/\.(jpg|jpeg|png|gif|webp)/i.test(obj) || /\/image|\/media|\/photo|\/catalog|wcsstore/i.test(obj)) {
      results.push(obj);
    }
    return results;
  }
  if (Array.isArray(obj)) { obj.forEach(v => findImageValues(v, depth + 1, results)); return results; }
  if (typeof obj === 'object') { Object.values(obj).forEach(v => findImageValues(v, depth + 1, results)); return results; }
  return results;
}

(async () => {
  console.log('Boots.com probe — RUN 6 (find product image URLs)');
  console.log('Date:', new Date().toISOString());

  // ── 1. WCS classic byId — print FULL JSON (not truncated) ──────────────
  const wcs = await get(
    `WCS classic byId ${TEST_UNIQUE_ID}`,
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/productview/byId/${TEST_UNIQUE_ID}?langId=-1&currency=GBP`
  );
  if (wcs?.data) {
    const imgVals = [...new Set(findImageValues(wcs.data))];
    console.log(`\n✅ Image-like values found (${imgVals.length}):`);
    imgVals.forEach(v => console.log('  ', v));

    // Print the SKUs section specifically
    const p = wcs.data.CatalogEntryView?.[0];
    if (p?.SKUs) {
      console.log('\nWCS SKUs[0] keys:', Object.keys(p.SKUs[0] || {}).join(', '));
      console.log('WCS SKUs[0] (first 2000 chars):\n', JSON.stringify(p.SKUs[0]).slice(0, 2000));
    }
    // Print fullImage if it exists
    if (p?.fullImage) console.log('\nfullImage:', p.fullImage);
    if (p?.thumbnail) console.log('thumbnail:', p.thumbnail);
  }

  // ── 2. Search byId for the SKU directly (not the parent product) ────────
  const skuSearch = await get(
    `Search byId for SKU ${TEST_SKU_ID}`,
    `${ORIGIN}/search/resources/store/${STORE_ID}/productview/byId/${TEST_SKU_ID}?lang=-1`
  );
  if (skuSearch?.data) {
    const imgVals = [...new Set(findImageValues(skuSearch.data))];
    console.log(`\n✅ Image-like values in SKU response (${imgVals.length}):`);
    imgVals.forEach(v => console.log('  ', v));
    console.log('\nFull SKU response (first 3000):\n', skuSearch.text.slice(0, 3000));
  }

  // ── 3. WCS classic byId for the SKU ─────────────────────────────────────
  const wcsSku = await get(
    `WCS classic byId for SKU ${TEST_SKU_ID}`,
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/productview/byId/${TEST_SKU_ID}?langId=-1&currency=GBP`
  );
  if (wcsSku?.data) {
    const imgVals = [...new Set(findImageValues(wcsSku.data))];
    console.log(`\n✅ Image-like values in WCS SKU response (${imgVals.length}):`);
    imgVals.forEach(v => console.log('  ', v));
    const p = wcsSku.data.CatalogEntryView?.[0];
    if (p?.fullImage) console.log('\nfullImage:', p.fullImage);
    if (p?.thumbnail) console.log('thumbnail:', p.thumbnail);
    console.log('\nAll keys:', Object.keys(p || {}).join(', '));
  }

  // ── 4. Try common Boots CDN image URL patterns ───────────────────────────
  hr();
  console.log('Testing known Boots image URL patterns for part', TEST_PART_NUM);
  const candidates = [
    `/medias/sys_master/images/hf5/${TEST_PART_NUM}.jpg`,
    `/wcsstore/eBootsStorefrontAssetStore/images/catalog/${TEST_PART_NUM}_ms.jpg`,
    `/wcsstore/eBootsStorefrontAssetStore/images/catalog/${TEST_PART_NUM}_ls.jpg`,
    `/wcsstore/eBootsStorefrontAssetStore/productimages/${TEST_PART_NUM}.jpg`,
    `/images/product/${TEST_PART_NUM}_ms.jpg`,
    `/images/product/${TEST_PART_NUM}.jpg`,
  ];
  for (const path of candidates) {
    try {
      const res = await fetch(`${ORIGIN}${path}`, {
        headers: { ...JSON_HEADERS, Accept: 'image/*,*/*' },
        redirect: 'follow',
      });
      const ct = res.headers.get('content-type') || '';
      console.log(`  ${res.status} ${ct.slice(0, 30).padEnd(30)} ${path}`);
      if (res.status === 200 && ct.includes('image')) {
        console.log(`  ⭐ VALID IMAGE: ${ORIGIN}${path}`);
      }
    } catch (err) {
      console.log(`  ERR ${path}: ${err.message}`);
    }
  }

  hr();
  console.log('PROBE COMPLETE');
  process.exit(0);
})();
