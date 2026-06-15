'use strict';

// Run with: node scripts/test-boots.js  OR  set TEST_BOOTS=1 in Bisect env and restart.
//
// FINDINGS SO FAR:
//   Platform: IBM WebSphere Commerce. storeId=11352, catalogId=28501.
//   Incapsula blocks text identifiers; numeric IDs pass through cleanly.
//   /wcs/resources/store/11352/productview/byCategory/{numericId} → works ✅
//   /search/resources/store/11352/productview/byCategory/{numericId} → works ✅ (richer data, has both prices)
//   Price: Display/L = was price, Offer/I = current price.
//   "beauty & skincare" category ID = 1595015.
//   This run: drill 1595015 → find skincare → find skincare-savings numeric ID.

const ORIGIN   = 'https://www.boots.com';
const STORE_ID = '11352';

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
      console.log('⚠️  INCAPSULA CHALLENGE — blocked'); return null;
    }
    try { return { status: res.status, data: JSON.parse(text) }; }
    catch { console.log('Not JSON. First 400:\n', text.slice(0, 400)); return null; }
  } catch (err) { console.log(`ERROR: ${err.message}`); return null; }
}

function printCats(cats, indent = '') {
  if (!Array.isArray(cats)) return;
  for (const c of cats) {
    console.log(`${indent}[${c.uniqueID}] "${c.name}" (${c.identifier})`);
    if (c.CatalogGroupView) printCats(c.CatalogGroupView, indent + '  ');
  }
}

function findByName(cats, keyword, results = []) {
  if (!Array.isArray(cats)) return results;
  for (const c of cats) {
    if ((c.name || '').toLowerCase().includes(keyword) || (c.identifier || '').toLowerCase().includes(keyword)) {
      results.push(c);
    }
    findByName(c.CatalogGroupView, keyword, results);
  }
  return results;
}

(async () => {
  console.log('Boots.com probe — RUN 4 (find skincare-savings numeric ID)');
  console.log('Date:', new Date().toISOString());

  // ── 1. Drill "beauty & skincare" (1595015) — depth 3, limit 50 ─────────
  const beauty = await get(
    'categoryview under beauty & skincare (1595015) — depth 3, limit 50',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/categoryview/byParentCategory/1595015?depthAndLimit=3,50&lang=-1`
  );

  let skincareId = null;
  let skincaresSavingsId = null;

  if (beauty?.data) {
    const cats = beauty.data.CatalogGroupView || [];
    console.log(`\nSubcategories of beauty & skincare (${cats.length} found):`);
    printCats(cats, '  ');

    // Auto-find skincare
    const skincareMatches = findByName(cats, 'skincare');
    if (skincareMatches.length) {
      console.log('\n⭐ Skincare matches:');
      skincareMatches.forEach(c => console.log(`  [${c.uniqueID}] "${c.name}" (${c.identifier})`));

      // Find skincare-savings specifically
      const savings = skincareMatches.find(c =>
        c.name.toLowerCase().includes('saving') || c.identifier.toLowerCase().includes('saving')
      );
      if (savings) {
        skincaresSavingsId = savings.uniqueID;
        console.log(`\n🎯 FOUND SKINCARE SAVINGS: [${savings.uniqueID}] "${savings.name}"`);
      } else {
        // Take the parent skincare category to drill further
        const parent = skincareMatches.find(c => !c.name.toLowerCase().includes('saving'));
        if (parent) skincareId = parent.uniqueID;
      }
    }
  }

  // ── 2. If we found skincare parent but not savings, drill one level deeper
  if (skincareId && !skincaresSavingsId) {
    const skincare = await get(
      `categoryview under skincare (${skincareId}) — depth 2, limit 50`,
      `${ORIGIN}/wcs/resources/store/${STORE_ID}/categoryview/byParentCategory/${skincareId}?depthAndLimit=2,50&lang=-1`
    );
    if (skincare?.data) {
      const cats = skincare.data.CatalogGroupView || [];
      console.log(`\nSubcategories of skincare (${cats.length}):`);
      printCats(cats, '  ');
      const savings = findByName(cats, 'saving');
      if (savings.length) {
        skincaresSavingsId = savings[0].uniqueID;
        console.log(`\n🎯 FOUND SKINCARE SAVINGS: [${savings[0].uniqueID}] "${savings[0].name}"`);
      }
    }
  }

  // ── 3. Verify: fetch products from skincare-savings by numeric ID ───────
  if (skincaresSavingsId) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🎯 Skincare savings category ID confirmed: ${skincaresSavingsId}`);
    console.log('Testing product fetch from /search/resources/ (richer data)...');

    const products = await get(
      `search/resources productview byCategory ${skincaresSavingsId} (page 1)`,
      `${ORIGIN}/search/resources/store/${STORE_ID}/productview/byCategory/${skincaresSavingsId}?pageSize=24&pageNumber=1&lang=-1`
    );
    if (products?.data) {
      const items = products.data.catalogEntryView || [];
      const total = products.data.recordSetTotal || products.data.recordSetTotalMatches;
      console.log(`\n✅ Products returned: ${items.length} (total in category: ${total})`);
      console.log(`   Pages needed: ${Math.ceil(total / 24)}`);

      // Print first 3 products with full price detail
      items.slice(0, 3).forEach((p, i) => {
        const offerPrice   = p.price?.find(x => x.usage === 'Offer')?.value;
        const displayPrice = p.price?.find(x => x.usage === 'Display')?.value;
        console.log(`\n  Product ${i + 1}:`);
        console.log(`    Name     : ${p.name}`);
        console.log(`    partNum  : ${p.partNumber}`);
        console.log(`    uniqueID : ${p.uniqueID}`);
        console.log(`    Price now: £${offerPrice}`);
        console.log(`    Was price: ${displayPrice ? '£' + displayPrice : '(not set)'}`);
        // Look for EAN/barcode
        const ean = p.attributes?.find(a => a.identifier === 'ean' || a.identifier === 'EAN' || a.identifier === 'barcode')?.values?.[0]?.value;
        if (ean) console.log(`    EAN      : ${ean}`);
        console.log(`    URL slug : ${p.seo?.href || p.seoUrl || '?'}`);
      });

      // Check attributes for EAN on all items
      const withEan = items.filter(p =>
        p.attributes?.some(a => ['ean','EAN','barcode','gtin','GTIN','EAN_Number'].includes(a.identifier))
      );
      console.log(`\n  Products with EAN attribute: ${withEan.length}/${items.length}`);
      if (withEan.length) {
        const sample = withEan[0];
        const eanAttr = sample.attributes.find(a => ['ean','EAN','barcode','gtin','GTIN','EAN_Number'].includes(a.identifier));
        console.log(`  Sample EAN attr: identifier="${eanAttr.identifier}" value="${eanAttr.values?.[0]?.value}"`);
      }

      // List all unique attribute identifiers across the 24 products
      const allAttrIds = [...new Set(items.flatMap(p => (p.attributes || []).map(a => a.identifier)))].sort();
      console.log(`\n  All attribute identifiers: ${allAttrIds.join(', ')}`);
    }

    // Also test WCS classic endpoint for comparison
    const wcsProducts = await get(
      `wcs/resources productview byCategory ${skincaresSavingsId} (page 1)`,
      `${ORIGIN}/wcs/resources/store/${STORE_ID}/productview/byCategory/${skincaresSavingsId}?pageSize=5&pageNumber=1&lang=-1&currency=GBP`
    );
    if (wcsProducts?.data) {
      const items = wcsProducts.data.CatalogEntryView || [];
      console.log(`\nWCS classic endpoint: ${items.length} products, total: ${wcsProducts.data.recordSetTotal}`);
      items.slice(0, 2).forEach(p => {
        console.log(`  ${p.name} — Price: ${JSON.stringify(p.Price)}`);
      });
    }
  } else {
    console.log('\n❌ Could not locate skincare-savings category ID automatically.');
    console.log('Check the category tree output above and report back with any "savings" category IDs.');
  }

  hr();
  console.log('PROBE COMPLETE');
  process.exit(0);
})();
