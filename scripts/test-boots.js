'use strict';

// Historical probe script — runs 1-9 used to reverse-engineer Boots WCS API.
// Key findings:
//   Platform:         IBM WebSphere Commerce. storeId=11352, catalogId=28501.
//   Category API:     /search/resources/store/11352/productview/byCategory/{numericId}
//   EAN:              attributes.find(identifier==="barcode").values[0].value — 100% populated
//   Prices:           Display/L = current sale price, Offer/I = was/normal price
//   Product URL:      sKUs[0].seo_token_ntk.split(';')[0] from search byId endpoint
//   Images:           https://boots.scene7.com/is/image/Boots/{partNumber}
//   Incapsula:        blocks HTML + text category slugs; numeric IDs on /search/resources bypass it
//   Category IDs:
//     Skincare Savings   2608697   (beauty & skincare → skincare → skincare savings)
//     Toiletries Offers  1595059   (toiletries → toiletries offers)
//     Fragrance Offers   1595046   (fragrance → fragrance offers)
//     Electrical Offers  1595111   (electrical → electrical offers)
//     Hair               1595040   (beauty & skincare → hair)
//
// To run new diagnostics: update this file and set TEST_BOOTS=1 on Bisect.

// ===== PROBE 10: Find numeric category ID for /tuesday-offer =====
// Goal: locate the WCS category ID for the weekly "£10 Tuesdays" promotion page.
// Strategy:
//   1. Try byIdentifier lookup using the URL slug "tuesday-offer"
//   2. Scan children of all known parent categories for anything Tuesday-related
//   3. Fetch one product from the /tuesday-offer page via product search to read its category breadcrumbs

const STORE_ID   = '11352';
const CATALOG_ID = '28501';
const BASE       = `https://www.boots.com/search/resources/store/${STORE_ID}`;
const HEADERS    = {
  'Accept':          'application/json, */*;q=0.9',
  'Accept-Language': 'en-GB,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Cache-Control':   'no-cache',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getChildren(parentId) {
  const url = `${BASE}/categoryview/byParentCategory/${parentId}?responseFormat=json&catalogId=${CATALOG_ID}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) { console.log(`  HTTP ${res.status} for parent ${parentId}`); return []; }
  const data = await res.json();
  return (data.catalogGroupView || []).map(c => ({
    id:   c.uniqueID,
    name: (c.name || '').trim(),
    seo:  (c.seo_token_ntk || '').trim(),
  }));
}

async function probe10() {
  console.log('\n===== PROBE 10: Tuesday Offer category lookup =====\n');

  // --- Step 1: byIdentifier lookup ---
  console.log('--- Step 1: byIdentifier lookup for "tuesday-offer" ---');
  const identUrl = `${BASE}/categoryview/byIdentifier?identifier=tuesday-offer&responseFormat=json&catalogId=${CATALOG_ID}`;
  const identRes = await fetch(identUrl, { headers: HEADERS });
  console.log(`byIdentifier HTTP: ${identRes.status}`);
  if (identRes.ok) {
    const d = await identRes.json();
    console.log('Result:', JSON.stringify(d).slice(0, 800));
  }
  await sleep(500);

  // --- Step 2: scan known parent categories and their children ---
  // Known parent IDs from previous probes plus some guesses for promotions
  const parentsToScan = [
    { id: '1590591', label: 'Shop by department (known)' },
    { id: '1595059', label: 'Toiletries Offers (known — scan siblings via its parent)' },
    // Try common WCS promotion/offers root IDs
    { id: '10052',   label: 'Possible root' },
    { id: '10702',   label: 'Possible offers root' },
    { id: '1594972', label: 'Possible promotions' },
  ];

  console.log('\n--- Step 2: scan children of known/candidate parents ---');
  for (const parent of parentsToScan) {
    console.log(`\nChildren of ${parent.id} (${parent.label}):`);
    const children = await getChildren(parent.id);
    if (children.length === 0) { console.log('  (none / not found)'); }
    for (const c of children) {
      const flag = (c.name.toLowerCase().includes('tuesday') || c.seo.toLowerCase().includes('tuesday'))
        ? ' <<<< TUESDAY FOUND'
        : '';
      console.log(`  ${c.id}: "${c.name}" [seo: ${c.seo}]${flag}`);
    }
    await sleep(400);
  }

  // --- Step 3: product search using the SEO slug to get breadcrumbs ---
  console.log('\n--- Step 3: product search with facet/category filter for tuesday-offer ---');
  // Try searching by the category SEO token directly in product search
  const searchUrl = `${BASE}/productview/bySearchTerm/*?searchTerm=*&categoryId=tuesday-offer&responseFormat=json&pageNumber=1&pageSize=3&catalogId=${CATALOG_ID}`;
  const searchRes = await fetch(searchUrl, { headers: HEADERS });
  console.log(`Product search (by seo slug) HTTP: ${searchRes.status}`);
  if (searchRes.ok) {
    const d = await searchRes.json();
    console.log('breadcrumbs:', JSON.stringify(d.breadCrumbTrailEntryView || []).slice(0, 400));
    console.log('facet categories:', JSON.stringify((d.facets || []).find(f => f.name === 'Category')).slice(0, 600));
  }
  await sleep(400);

  // --- Step 4: try the top-level category tree to find any "Offers" root ---
  console.log('\n--- Step 4: drill top-level to find offers/promotions branch ---');
  // The WCS top-level catalog root is usually fetched with an empty/root parent
  for (const rootGuess of ['10052', '10702', '10051', '10053']) {
    const children = await getChildren(rootGuess);
    if (children.length > 0) {
      console.log(`\nRoot ${rootGuess} has ${children.length} children:`);
      for (const c of children) {
        console.log(`  ${c.id}: "${c.name}" [${c.seo}]`);
      }
      break;
    }
    await sleep(300);
  }
}

probe10()
  .then(() => { console.log('\nProbe 10 complete.'); process.exit(0); })
  .catch(e => { console.error('Probe 10 error:', e); process.exit(1); });
