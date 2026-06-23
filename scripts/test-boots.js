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
// Probe 10 findings:
//   /tuesday-offer is NOT a standard WCS category (byIdentifier returns empty).
//   It is a CMS/marketing page — no numeric ID at the top level.
//   1590591 ("Shop by department") children are top-level departments, no Tuesday there.
//
// To run new diagnostics: update this file and set TEST_BOOTS=1 on Bisect.

// ===== PROBE 11: Deep scan for Tuesday Offer + product breadcrumb extraction =====
// Goal: determine what API backs /tuesday-offer — either a deep nested category,
//       a promotions endpoint, or a product attribute filter.
// Strategy:
//   1. Scan all level-2 children of 1590591 to find any Tuesday sub-category
//   2. Try product text search for "tuesday" and read category breadcrumbs
//   3. Try WCS eSpot API and promotion REST endpoints
//   4. Fetch first product listed on the page via the criteria.* search pattern

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
  if (!res.ok) return [];
  const data = await res.json();
  return (data.catalogGroupView || []).map(c => ({
    id:   c.uniqueID,
    name: (c.name || '').trim(),
    seo:  (c.seo_token_ntk || '').trim(),
  }));
}

async function probe11() {
  console.log('\n===== PROBE 11: Deep scan for Tuesday Offer =====\n');

  // --- Step 1: Level-2 scan — children of each child of 1590591 ---
  console.log('--- Step 1: Level-2 scan under 1590591 ---');
  const level1 = [
    { id: '2624680', name: 'love island' },
    { id: '2596184', name: 'trending on social' },
    { id: '1595022', name: 'sun & holiday' },
    { id: '1860697', name: 'wellness' },
    { id: '1923680', name: 'clearance' },
    { id: '1595014', name: 'health & pharmacy' },
    { id: '1595015', name: 'beauty & skincare' },
    { id: '1595016', name: 'fragrance' },
    { id: '1595017', name: 'baby & child' },
    { id: '1595019', name: 'electrical' },
    { id: '2640183', name: 'new in' },
    { id: '1595018', name: 'toiletries' },
    { id: '1933680', name: 'men\'s' },
    { id: '3257682', name: 'homeware' },
    { id: '1595023', name: 'gift' },
  ];

  let foundTuesday = null;
  for (const parent of level1) {
    const children = await getChildren(parent.id);
    const tuesdayHit = children.find(c =>
      c.name.toLowerCase().includes('tuesday') || c.seo.toLowerCase().includes('tuesday')
    );
    if (tuesdayHit) {
      console.log(`*** TUESDAY FOUND under "${parent.name}" (${parent.id}) ***`);
      console.log(`    ID: ${tuesdayHit.id}  name: "${tuesdayHit.name}"  seo: ${tuesdayHit.seo}`);
      foundTuesday = tuesdayHit;
    } else if (children.length > 0) {
      // Print offer-sounding children only
      const offerKids = children.filter(c =>
        /offer|deal|sale|promo|saving|discount|tuesday|week|daily/i.test(c.name)
      );
      if (offerKids.length) {
        console.log(`  "${parent.name}" offer-related children:`);
        offerKids.forEach(c => console.log(`    ${c.id}: "${c.name}" [${c.seo}]`));
      }
    }
    await sleep(200);
  }

  if (!foundTuesday) {
    console.log('\n(Tuesday not found in level-2 — not a nested category)');
  }

  // --- Step 2: Product text search for "tuesday" — read breadcrumbs ---
  console.log('\n--- Step 2: Product search breadcrumbs for "tuesday offer" ---');
  const searchUrl = `${BASE}/productview/bySearchTerm/tuesday%20offer?responseFormat=json&pageNumber=1&pageSize=3&catalogId=${CATALOG_ID}`;
  const searchRes = await fetch(searchUrl, { headers: HEADERS });
  console.log(`Search HTTP: ${searchRes.status}`);
  if (searchRes.ok) {
    const d = await searchRes.json();
    console.log('Total results:', d.recordSetTotal);
    console.log('Breadcrumbs:', JSON.stringify(d.breadCrumbTrailEntryView || []));
    const catFacet = (d.facets || []).find(f => f.name?.toLowerCase() === 'category');
    if (catFacet) console.log('Category facet entries:', JSON.stringify(catFacet.entry?.slice(0, 10)));
    // Print first product's categories
    const p = (d.catalogEntryView || [])[0];
    if (p) console.log('First product partNum:', p.partNumber, 'name:', p.shortDescription);
  }
  await sleep(400);

  // --- Step 3: Try WCS eSpot (e-marketing spot) for tuesday page ---
  console.log('\n--- Step 3: eSpot lookup for "tuesday-offer" ---');
  for (const spotName of ['tuesday-offer', 'TuesdayOffer', 'TUESDAY_OFFER', 'tuesday_offer']) {
    const espotUrl = `${BASE}/spot/activity/${encodeURIComponent(spotName)}?responseFormat=json&catalogId=${CATALOG_ID}`;
    const espotRes = await fetch(espotUrl, { headers: HEADERS });
    console.log(`eSpot "${spotName}": HTTP ${espotRes.status}`);
    if (espotRes.ok) {
      const d = await espotRes.json();
      console.log('eSpot result:', JSON.stringify(d).slice(0, 600));
    }
    await sleep(200);
  }

  // --- Step 4: Try byCategory with the SEO slug as the ID directly ---
  console.log('\n--- Step 4: Try productview/byCategory with slug-style identifiers ---');
  for (const id of ['tuesday-offer', 'tuesdayoffer']) {
    const url = `${BASE}/productview/byCategory/${id}?responseFormat=json&pageNumber=1&pageSize=3&catalogId=${CATALOG_ID}`;
    const res = await fetch(url, { headers: HEADERS });
    console.log(`byCategory "${id}": HTTP ${res.status}`);
    if (res.ok) {
      const d = await res.json();
      console.log('Total:', d.recordSetTotal, 'breadcrumbs:', JSON.stringify(d.breadCrumbTrailEntryView || []));
    }
    await sleep(200);
  }

  // --- Step 5: Try the criteria-based search endpoint WCS uses for /tuesday-offer ---
  console.log('\n--- Step 5: criteria-based product search (mimics page URL params) ---');
  const criteriaUrl = `${BASE}/productview/bySearchTerm/*?searchTerm=*&intent=&pageSize=5&pageNumber=1&responseFormat=json&catalogId=${CATALOG_ID}&facet=category%3Atuesday-offer`;
  const criteriaRes = await fetch(criteriaUrl, { headers: HEADERS });
  console.log(`Criteria search HTTP: ${criteriaRes.status}`);
  if (criteriaRes.ok) {
    const d = await criteriaRes.json();
    console.log('Total:', d.recordSetTotal, 'breadcrumbs:', JSON.stringify(d.breadCrumbTrailEntryView || []));
  }
}

probe11()
  .then(() => { console.log('\nProbe 11 complete.'); process.exit(0); })
  .catch(e => { console.error('Probe 11 error:', e); process.exit(1); });
