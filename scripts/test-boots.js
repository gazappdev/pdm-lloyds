'use strict';

// Run with: node scripts/test-boots.js  OR  set TEST_BOOTS=1 in Bisect env and restart.
// Purpose : probe boots.com to determine reachability and API structure from this host.
//
// FINDINGS SO FAR:
//   - Incapsula blocks HTML pages and text-based category identifiers.
//   - WCS REST (/wcs/resources/store/11352/) and Search REST (/search/resources/store/11352/)
//     respond with real JSON — bypasses Incapsula completely.
//   - Platform: IBM WebSphere Commerce. storeId=11352, catalogId=28501.
//   - /search/resources/ has richer data: both Display (was) price and Offer (current) price.
//   - Numeric category IDs needed to call /productview/byCategory/{numericId}.
//   - This run: drill category tree to find skincare-savings numeric ID, then verify product fetch.

const ORIGIN     = 'https://www.boots.com';
const STORE_ID   = '11352';

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
    console.log(`Status : ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`Body len : ${text.length} chars`);

    if (text.includes('reeseSkipExpirationCheck') || text.includes('Pardon Our Interruption')) {
      console.log('⚠️  INCAPSULA CHALLENGE — blocked');
      return null;
    }

    try {
      const data = JSON.parse(text);
      return { status: res.status, data, text };
    } catch {
      console.log('Not JSON. First 600:\n', text.slice(0, 600));
      return { status: res.status, data: null, text };
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    return null;
  }
}

function printCategories(cats, indent = '') {
  if (!Array.isArray(cats)) return;
  for (const c of cats) {
    const id   = c.uniqueID   || c.categoryId || '?';
    const name = c.name       || c.identifier  || '?';
    const ident= c.identifier || '';
    console.log(`${indent}[${id}] ${name} (identifier: ${ident})`);
    if (c.CatalogGroupView) printCategories(c.CatalogGroupView, indent + '  ');
    if (c.children)         printCategories(c.children,         indent + '  ');
  }
}

(async () => {
  console.log('Boots.com probe — RUN 3 (find skincare-savings category ID)');
  console.log('Date:', new Date().toISOString());

  // ── 1. SEO URL resolver (corrected endpoint format) ────────────────────
  // The error in run 2 told us the parameter key should be "byUrlKeywordNames"
  const seo1 = await get(
    'WCS SEO byUrlKeywordNames (path variant)',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/seo/byUrlKeywordNames/beauty%2Fskincare%2Fskincare-savings`
  );
  if (seo1?.data) console.log('SEO result:', JSON.stringify(seo1.data).slice(0, 1000));

  const seo2 = await get(
    'WCS SEO byUrlKeywordNames (query param)',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/seo/byUrlKeywordNames?urlKeywordNames=beauty%2Fskincare%2Fskincare-savings`
  );
  if (seo2?.data) console.log('SEO result:', JSON.stringify(seo2.data).slice(0, 1000));

  // ── 2. Category by identifier (URL slug) ───────────────────────────────
  const byId = await get(
    'categoryview byIdentifier: beauty-skincare-savings',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/categoryview/byIdentifier/beauty-skincare-savings`
  );
  if (byId?.data) {
    console.log('Keys:', Object.keys(byId.data).join(', '));
    console.log(JSON.stringify(byId.data).slice(0, 1000));
  }

  // ── 3. Drill from top: "Shop by department" (1590591) — find Beauty ────
  const shopDept = await get(
    'categoryview under Shop by dept (1590591) — depth 1, limit 30',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/categoryview/byParentCategory/1590591?depthAndLimit=1,30&lang=-1`
  );
  if (shopDept?.data) {
    const cats = shopDept.data.CatalogGroupView || [];
    console.log(`\nSubcategories of "Shop by dept" (${cats.length}):`);
    printCategories(cats);
  }

  // ── 4. Drill from "Offers" (2357689) — find beauty savings ─────────────
  const offers = await get(
    'categoryview under Offers (2357689) — depth 2, limit 20',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/categoryview/byParentCategory/2357689?depthAndLimit=2,20&lang=-1`
  );
  if (offers?.data) {
    const cats = offers.data.CatalogGroupView || [];
    console.log(`\nSubcategories of Offers (${cats.length}):`);
    printCategories(cats, '  ');
    // Auto-search for skincare
    const raw = JSON.stringify(cats);
    const skinMatch = raw.match(/"uniqueID":"(\d+)"[^}]*"(?:name|identifier)":"[^"]*[Ss]kincare[^"]*"/g);
    if (skinMatch) console.log('\n⭐ Skincare matches:', skinMatch.join('\n'));
  }

  // ── 5. Full category tree dump with deeper depth ───────────────────────
  const deep = await get(
    'categoryview @top with depth 3',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/categoryview/@top?depthAndLimit=3,50&lang=-1`
  );
  if (deep?.data) {
    const cats = deep.data.CatalogGroupView || [];
    console.log(`\nFull category tree (depth 3, ${cats.length} top-level):`);
    printCategories(cats);
  }

  // ── 6. Try productview/byCategory with known numeric Offers ID ─────────
  //    Just to verify numeric IDs work (Incapsula may not block numeric IDs)
  const testNumeric = await get(
    'productview byCategory with NUMERIC ID 2357689 (Offers) — does Incapsula block?',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/productview/byCategory/2357689?pageSize=5&pageNumber=1&lang=-1&currency=GBP`
  );
  if (testNumeric?.data) {
    console.log('✅ Numeric category ID works! Keys:', Object.keys(testNumeric.data).join(', '));
    console.log('Total products:', testNumeric.data.recordSetTotal);
    console.log(JSON.stringify(testNumeric.data).slice(0, 1000));
  }

  // ── 7. Search API: byCategory using Offers ID (to check price structure)
  const searchByCat = await get(
    '/search/resources productview byCategory 2357689 (Offers)',
    `${ORIGIN}/search/resources/store/${STORE_ID}/productview/byCategory/2357689?pageSize=5&pageNumber=1&lang=-1`
  );
  if (searchByCat?.data) {
    console.log('✅ Search byCategory result. Keys:', Object.keys(searchByCat.data).join(', '));
    console.log('Total:', searchByCat.data.recordSetTotal || searchByCat.data.recordSetTotalMatches);
    // Print first product's price structure
    const first = (searchByCat.data.catalogEntryView || searchByCat.data.CatalogEntryView || [])[0];
    if (first) {
      console.log('\nFirst product price structure:');
      console.log(JSON.stringify({ name: first.name, price: first.price || first.Price, uniqueID: first.uniqueID, partNumber: first.partNumber }));
    }
  }

  hr();
  console.log('PROBE COMPLETE');
  process.exit(0);
})();
