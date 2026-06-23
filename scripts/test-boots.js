'use strict';

// Historical probe script — runs 1-11 used to reverse-engineer Boots WCS API.
// Key findings:
//   Platform:         IBM WebSphere Commerce. storeId=11352, catalogId=28501.
//   Category API:     /search/resources/store/11352/productview/byCategory/{numericId}
//   EAN:              attributes.find(identifier==="barcode").values[0].value — 100% populated
//   Prices:           Display/L = current sale price, Offer/I = was/normal price
//   Product URL:      sKUs[0].seo_token_ntk.split(';')[0] from search byId endpoint
//   Images:           https://boots.scene7.com/is/image/Boots/{partNumber}
//   Incapsula:        blocks HTML + non-numeric-ID paths; numeric IDs on /search/resources bypass it
//   Category IDs found:
//     Skincare Savings   2608697
//     Toiletries Offers  1595059
//     Fragrance Offers   1595046
//     Electrical Offers  1595111
//     Hair               1595040
//   /tuesday-offer is NOT a WCS category (byIdentifier = 0 results, not in level-1 or level-2 tree)
//
// To run new diagnostics: update this file and set TEST_BOOTS=1 on Bisect.

// ===== PROBE 12: Find tree root + siblings of 1590591 + JS bundle probe =====
// Goal: find if there is a separate "Offers/Deals/Promotions" branch at the top level
//       that contains Tuesday Offer, separate from "Shop by department" (1590591).
// Also: probe boots.com JS bundle URLs (likely on a CDN, not Incapsula-blocked)
//       to find what WCS query parameters the /tuesday-offer page component uses.

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

async function tryParent(id) {
  const url = `${BASE}/categoryview/byParentCategory/${id}?responseFormat=json&catalogId=${CATALOG_ID}`;
  const res = await fetch(url, { headers: HEADERS });
  const body = await res.text();
  if (!body.trimStart().startsWith('{')) return null;
  try {
    const d = JSON.parse(body);
    return d.catalogGroupView || null;
  } catch { return null; }
}

async function probe12() {
  console.log('\n===== PROBE 12: Tree root hunt + JS bundle probe =====\n');

  // --- Step 1: Probe candidate root/parent IDs for the Boots category tree ---
  // We know 1590591 = "Shop by department". If its parent exists, siblings might
  // include an "Offers" or "Deals" section containing Tuesday Offer.
  console.log('--- Step 1: Probe candidate root / parent IDs ---');
  const candidates = [0, 1, 10, 100, 1000, 10000, 100000, 11352, 28501,
                      1590590, 1590592, 1595000, 1595010, 1595011, 1595012, 1595013,
                      1595020, 1595021, 1595024, 1595025, 1595026, 1595027, 1595028,
                      1595029, 1595030, 1595100, 1590000, 1600000];
  for (const id of candidates) {
    const kids = await tryParent(id);
    if (kids === null) { process.stdout.write('.'); continue; }
    if (kids.length === 0) { process.stdout.write('o'); continue; }
    const names = kids.map(c => `${c.uniqueID}="${(c.name||'').trim()}"`).join(', ');
    const hasTuesday = names.toLowerCase().includes('tuesday');
    const marker = hasTuesday ? '*** TUESDAY ***' : '';
    console.log(`\n  Parent ${id} → ${kids.length} children: ${names} ${marker}`);
    await sleep(150);
  }
  console.log('\n');

  // --- Step 2: Try bySearchTerm with a real short term and dump ALL facets ---
  // Step 6 in probe 11 returned empty facets from wildcard — try a real term.
  console.log('\n--- Step 2: Facets from a real product search ---');
  const searchUrl = `${BASE}/productview/bySearchTerm/lipstick?responseFormat=json&pageSize=1&pageNumber=1&catalogId=${CATALOG_ID}`;
  const searchRes = await fetch(searchUrl, { headers: HEADERS });
  const searchBody = await searchRes.text();
  if (searchBody.trimStart().startsWith('{')) {
    const d = JSON.parse(searchBody);
    console.log('Total:', d.recordSetTotal);
    for (const f of (d.facets || [])) {
      const entries = (f.entry || []).map(e => e.label || e.value).join(', ');
      console.log(`  Facet "${f.name}": ${entries.slice(0, 200)}`);
    }
  } else {
    console.log('Blocked/HTML');
  }
  await sleep(300);

  // --- Step 3: Try to detect Tuesday Offer category via byIdentifier with variants ---
  console.log('\n--- Step 3: byIdentifier with more slug variants ---');
  const slugs = ['tuesday-offer', 'tuesday', 'tuesdayoffer', 'tuesday_offer',
                 'TuesdayOffer', 'TUESDAY', 'offers', 'deals', 'weekly-offers',
                 'weekly-deals', 'boots-offers', 'value', 'pharmacy-offers'];
  for (const slug of slugs) {
    const url = `${BASE}/categoryview/byIdentifier?identifier=${encodeURIComponent(slug)}&responseFormat=json&catalogId=${CATALOG_ID}`;
    const res = await fetch(url, { headers: HEADERS });
    const body = await res.text();
    if (body.trimStart().startsWith('{')) {
      const d = JSON.parse(body);
      if (d.recordSetTotal > 0) {
        const cat = d.catalogGroupView[0];
        console.log(`*** HIT "${slug}": ID=${cat.uniqueID} name="${cat.name}" ***`);
      } else {
        process.stdout.write('.');
      }
    } else {
      process.stdout.write('X');
    }
    await sleep(150);
  }
  console.log();
  await sleep(200);

  // --- Step 4: Try to access boots.com JS bundle for Tuesday page component ---
  // React SPAs bundle their page-component configs. If the JS bundle is on a CDN
  // that bypasses Incapsula, we can search it for "tuesday-offer" query params.
  console.log('\n--- Step 4: Probe known boots.com JS bundle paths ---');
  const jsPaths = [
    'https://www.boots.com/_next/static/chunks/pages/tuesday-offer.js',
    'https://www.boots.com/_next/static/chunks/tuesday.js',
    'https://static.boots.com/resource/boots/js/app.js',
    'https://www.boots.com/ResourceServlet/wcsstore/BootsStorefrontAssetStore/javascript/boots-app.js',
  ];
  for (const url of jsPaths) {
    const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    console.log(`[${res.status}] ${url.split('/').slice(-2).join('/')} (${ct})`);
    if (res.ok && (ct.includes('javascript') || ct.includes('text'))) {
      // search for tuesday-related params
      const idx = body.toLowerCase().indexOf('tuesday');
      if (idx >= 0) {
        console.log(`  *** "tuesday" found at pos ${idx}: ...${body.slice(Math.max(0,idx-50), idx+200)}...`);
      } else {
        console.log('  (no "tuesday" string in bundle)');
      }
    }
    await sleep(200);
  }

  // --- Step 5: Check boots.com Next.js build ID (to get correct bundle names) ---
  console.log('\n--- Step 5: Try boots.com Next.js manifest for bundle names ---');
  const manifestUrls = [
    'https://www.boots.com/_next/static/chunks/webpack.js',
    'https://www.boots.com/_next/static/webpack/webpack.hot-update.json',
    'https://www.boots.com/api/health',
    'https://www.boots.com/_next/data/health.json',
  ];
  for (const url of manifestUrls) {
    const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    console.log(`[${res.status}] ${url.split('/').slice(-2).join('/')} (${ct})`);
    if (res.ok && body.length < 5000) console.log('  body:', body.slice(0, 300));
    await sleep(200);
  }
}

probe12()
  .then(() => { console.log('\nProbe 12 complete.'); process.exit(0); })
  .catch(e => { console.error('Probe 12 error:', e); process.exit(1); });
