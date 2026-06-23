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
  // WCS eSpot REST paths vary by install — try multiple patterns.
  // Previously /spot/activity/ returned HTML (wrong path).
  console.log('\n--- Step 3: eSpot lookup for "tuesday-offer" ---');
  const espotPatterns = [
    `${BASE}/espot/tuesday-offer`,
    `${BASE}/espot/byName/tuesday-offer`,
    `https://www.boots.com/wcs/resources/store/${STORE_ID}/espot/tuesday-offer`,
    `https://www.boots.com/wcs/resources/store/${STORE_ID}/spot/activity/tuesday-offer`,
    `https://www.boots.com/webapp/wcs/stores/servlet/GetProductsForCategory?categoryId=tuesday-offer&storeId=${STORE_ID}&catalogId=${CATALOG_ID}&responseFormat=json`,
  ];
  for (const url of espotPatterns) {
    const res = await fetch(url, { headers: HEADERS });
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    const isJson = ct.includes('json') || body.trimStart().startsWith('{') || body.trimStart().startsWith('[');
    console.log(`[${res.status}] ${url.replace('https://www.boots.com', '')}`);
    if (isJson) {
      try { console.log('  JSON:', JSON.stringify(JSON.parse(body)).slice(0, 400)); } catch { console.log('  body:', body.slice(0, 200)); }
    } else {
      console.log(`  HTML/other (${ct}), first 100 chars:`, body.slice(0, 100).replace(/\s+/g, ' '));
    }
    await sleep(200);
  }

  // --- Step 4: Try byCategory with the SEO slug as the ID directly ---
  console.log('\n--- Step 4: Try productview/byCategory with slug-style identifiers ---');
  for (const id of ['tuesday-offer', 'tuesdayoffer']) {
    const url = `${BASE}/productview/byCategory/${id}?responseFormat=json&pageNumber=1&pageSize=3&catalogId=${CATALOG_ID}`;
    const res = await fetch(url, { headers: HEADERS });
    const ct4 = res.headers.get('content-type') || '';
    const body4 = await res.text();
    const isJson4 = ct4.includes('json') || body4.trimStart().startsWith('{');
    console.log(`byCategory "${id}": HTTP ${res.status} (${isJson4 ? 'json' : 'html'})`);
    if (isJson4) {
      try {
        const d = JSON.parse(body4);
        console.log('Total:', d.recordSetTotal, 'breadcrumbs:', JSON.stringify(d.breadCrumbTrailEntryView || []));
      } catch { console.log('parse err'); }
    } else {
      console.log('  first 100:', body4.slice(0, 100).replace(/\s+/g, ' '));
    }
    await sleep(200);
  }

  // --- Step 5: criteria-based search with facet=category:tuesday-offer ---
  console.log('\n--- Step 5: criteria-based product search (mimics page URL params) ---');
  const criteriaUrl = `${BASE}/productview/bySearchTerm/*?searchTerm=*&intent=&pageSize=5&pageNumber=1&responseFormat=json&catalogId=${CATALOG_ID}&facet=category%3Atuesday-offer`;
  const criteriaRes = await fetch(criteriaUrl, { headers: HEADERS });
  const ct5 = criteriaRes.headers.get('content-type') || '';
  const body5 = await criteriaRes.text();
  console.log(`Criteria search HTTP: ${criteriaRes.status} (${ct5})`);
  if (ct5.includes('json') || body5.trimStart().startsWith('{')) {
    try {
      const d = JSON.parse(body5);
      console.log('Total:', d.recordSetTotal, 'breadcrumbs:', JSON.stringify(d.breadCrumbTrailEntryView || []));
    } catch { console.log('parse err'); }
  } else {
    console.log('  first 100:', body5.slice(0, 100).replace(/\s+/g, ' '));
  }

  // --- Step 6: All-product search — dump facet names to see if "tuesday" appears as a facet ---
  console.log('\n--- Step 6: Dump all facet names from wildcard search ---');
  const facetUrl = `${BASE}/productview/bySearchTerm/*?searchTerm=*&pageSize=1&pageNumber=1&responseFormat=json&catalogId=${CATALOG_ID}`;
  const facetRes = await fetch(facetUrl, { headers: HEADERS });
  const body6 = await facetRes.text();
  console.log(`Facet search HTTP: ${facetRes.status}`);
  if (body6.trimStart().startsWith('{')) {
    try {
      const d = JSON.parse(body6);
      const facetNames = (d.facets || []).map(f => `${f.name} (${(f.entry || []).length} entries)`);
      console.log('Facet names:', facetNames.join(', '));
      for (const f of (d.facets || [])) {
        if (/offer|promo|deal|tuesday|discount/i.test(f.name)) {
          console.log(`  Facet "${f.name}" entries:`, JSON.stringify((f.entry || []).slice(0, 20)));
        }
      }
    } catch { console.log('parse err'); }
  } else {
    console.log('  first 100:', body6.slice(0, 100).replace(/\s+/g, ' '));
  }

  // --- Step 7: Fetch /tuesday-offer page itself and look at redirect or headers ---
  console.log('\n--- Step 7: HEAD /tuesday-offer to see redirect/headers ---');
  const pageRes = await fetch('https://www.boots.com/tuesday-offer?criteria.inStock=true', {
    method: 'HEAD',
    headers: { ...HEADERS, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
    redirect: 'manual',
  });
  console.log(`HEAD /tuesday-offer: HTTP ${pageRes.status}`);
  console.log('Location header:', pageRes.headers.get('location'));
  console.log('Content-Type:', pageRes.headers.get('content-type'));
  for (const [k, v] of pageRes.headers.entries()) {
    if (/x-|cf-|incap|set-cookie/i.test(k)) console.log(`  ${k}: ${v.slice(0, 80)}`);
  }
}

probe11()
  .then(() => { console.log('\nProbe 11 complete.'); process.exit(0); })
  .catch(e => { console.error('Probe 11 error:', e); process.exit(1); });
