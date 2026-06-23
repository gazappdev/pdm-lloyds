'use strict';

// Probe history notes:
//   Platform:  IBM WebSphere Commerce. storeId=11352, catalogId=28501.
//   Working:   /search/resources/store/11352/productview|categoryview/... with numeric IDs
//   Blocked:   All non-numeric-ID paths (Incapsula). eSpot API blocked. JS bundles 404.
//   Category IDs:
//     1590591  = Shop by department (root of browsable tree)
//     1595024  = Offers aggregate (parent of all dept-offer subcategories) — NOT under 1590591
//     1595014  = health & pharmacy
//     1595015  = beauty & skincare
//     1595016  = fragrance
//     1595017  = baby & child
//     1595018  = toiletries
//     1595019  = electrical
//     1595020  = opticians
//     1595021  = photo
//     1595022  = sun & holiday
//     1595023  = gift
//     1595040  = hair (under beauty)
//     1595042  = skincare offers
//     1595046  = fragrance offers
//     1595059  = toiletries offers
//     1595072  = opticians offers
//     1595110  = baby & child offers
//     1595111  = electrical offers
//     2608697  = skincare savings
//     2921187  = makeup offers
//   /tuesday-offer is NOT a WCS category at any level explored so far.
//
// Set TEST_BOOTS=1 on Bisect to run this file instead of the main scraper.

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

async function safeJson(url, extraHeaders = {}) {
  try {
    const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
    const body = await res.text();
    if (!body.trimStart().startsWith('{') && !body.trimStart().startsWith('[')) return null;
    return JSON.parse(body);
  } catch { return null; }
}

async function getChildren(parentId, pageSize = 50) {
  const url = `${BASE}/categoryview/byParentCategory/${parentId}?responseFormat=json&catalogId=${CATALOG_ID}&pageSize=${pageSize}`;
  const d = await safeJson(url);
  if (!d) return null;
  return d.catalogGroupView || [];
}

async function probe13() {
  console.log('\n===== PROBE 13: Extended tree search + 1590591 pagination =====\n');

  // --- Step 1: Re-scan 1590591 with large pageSize to catch paginated children ---
  // WCS may have truncated the child list in earlier probes.
  console.log('--- Step 1: Children of 1590591 with pageSize=100 ---');
  const top = await getChildren('1590591', 100);
  if (top) {
    console.log(`Total children: ${top.length}`);
    top.forEach(c => console.log(`  ${c.uniqueID}: "${(c.name||'').trim()}"`));
    const hasTuesday = top.some(c => (c.name||'').toLowerCase().includes('tuesday'));
    console.log(hasTuesday ? '*** TUESDAY FOUND ***' : '(no Tuesday child)');
  } else {
    console.log('No data');
  }
  await sleep(300);

  // --- Step 2: Check 1595024 ("offers" parent) — try to get its own record ---
  // byIdentifier for 1595024 as a number might return parent info.
  console.log('\n--- Step 2: byIdentifier lookup for 1595024 as uniqueID ---');
  const offersCat = await safeJson(
    `${BASE}/categoryview/byIdentifier?uniqueId=1595024&responseFormat=json&catalogId=${CATALOG_ID}`
  );
  console.log('byIdentifier uniqueId=1595024:', offersCat ? JSON.stringify(offersCat).slice(0, 400) : 'null/blocked');
  await sleep(200);

  // --- Step 3: Scan 1595000–1595013 and 1595024 itself as a parent ---
  // We haven't checked IDs 1595001–1595013 (gaps between known nodes).
  console.log('\n--- Step 3: Scan gaps in the 1595000-1595013 range ---');
  for (let id = 1595001; id <= 1595013; id++) {
    const kids = await getChildren(String(id));
    if (kids === null) { process.stdout.write('.'); }
    else if (kids.length === 0) { process.stdout.write('o'); }
    else {
      const names = kids.map(c => `${c.uniqueID}="${(c.name||'').trim()}"`).join(', ');
      const flag = names.toLowerCase().includes('tuesday') ? ' *** TUESDAY ***' : '';
      console.log(`\n  ${id} → ${kids.length}: ${names}${flag}`);
    }
    await sleep(100);
  }

  // Scan 1595031–1595045 (between known 1595030 and 1595042)
  console.log('\n--- Step 3b: Scan 1595031-1595044 ---');
  for (let id = 1595031; id <= 1595044; id++) {
    const kids = await getChildren(String(id));
    if (kids === null) { process.stdout.write('.'); }
    else if (kids.length === 0) { process.stdout.write('o'); }
    else {
      const names = kids.map(c => `${c.uniqueID}="${(c.name||'').trim()}"`).join(', ');
      const flag = names.toLowerCase().includes('tuesday') ? ' *** TUESDAY ***' : '';
      console.log(`\n  ${id} → ${kids.length}: ${names}${flag}`);
    }
    await sleep(100);
  }
  console.log();
  await sleep(200);

  // --- Step 4: Scan ranges that might be the true root ---
  // 1590591 is a child of something. Its parent might be in 1000000-1590590 range.
  // Try sparse samples.
  console.log('\n--- Step 4: Sparse root probe (looking for 1590591 as a child) ---');
  const rootCandidates = [
    // Very small IDs
    2, 3, 4, 5, 50, 200, 500,
    // Common WCS root IDs
    10001, 10002, 10003, 10004, 10005,
    // Store-like IDs
    11350, 11351, 11353, 11354,
    // Near 1590591 from above
    1590580, 1590585, 1590588, 1590589, 1590593, 1590595, 1590600,
    // Catalog-level
    28500, 28501, 28502,
    // Round numbers in the range
    1000000, 1100000, 1200000, 1300000, 1400000, 1500000,
    1550000, 1580000, 1590000, 1590500, 1590550, 1590560, 1590570,
  ];
  for (const id of rootCandidates) {
    const kids = await getChildren(String(id));
    if (kids === null) { process.stdout.write('.'); continue; }
    if (kids.length === 0) { process.stdout.write('o'); continue; }
    const names = kids.map(c => `${c.uniqueID}="${(c.name||'').trim()}"`).join(', ');
    const isRoot = kids.some(c => c.uniqueID === '1590591');
    const flag = isRoot ? ' *** ROOT FOUND ***' : names.toLowerCase().includes('tuesday') ? ' *** TUESDAY ***' : '';
    console.log(`\n  ${id} → ${kids.length}: ${names.slice(0, 200)}${flag}`);
    await sleep(150);
  }
  console.log();
  await sleep(200);

  // --- Step 5: Try boots.com Next.js build-id and page data endpoints ---
  // Next.js exposes /_next/BUILD_ID and page JSON data without Incapsula protection.
  console.log('\n--- Step 5: Next.js build info and page data probe ---');
  const nextPaths = [
    'https://www.boots.com/_next/BUILD_ID',
    'https://www.boots.com/_next/static/webpack/webpack.hot-update.json',
  ];
  for (const url of nextPaths) {
    const d = await safeJson(url);
    const textRes = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } }).catch(() => null);
    if (textRes) {
      const ct = textRes.headers.get('content-type') || '';
      const body = await textRes.text().catch(() => '');
      console.log(`[${textRes.status}] ${url.split('/').pop()} (${ct}): ${body.slice(0, 200)}`);
    }
    await sleep(200);
  }

  // Try fetching a Next.js data JSON for the tuesday-offer page
  // Next.js pre-renders data as /_next/data/{buildId}/tuesday-offer.json
  // We need the buildId first — from BUILD_ID or from HTML (blocked).
  // Try a few guessed buildId values from common patterns.
  console.log('\nTrying /_next/data variants:');
  const dataPaths = [
    'https://www.boots.com/_next/data/latest/tuesday-offer.json',
    'https://www.boots.com/_next/data/build/tuesday-offer.json',
    'https://www.boots.com/api/page/tuesday-offer',
    'https://www.boots.com/api/products?page=tuesday-offer',
    'https://www.boots.com/api/cms/tuesday-offer',
  ];
  for (const url of dataPaths) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'application/json' } });
      const ct = res.headers.get('content-type') || '';
      const body = await res.text();
      const isJson = ct.includes('json') || body.trimStart().startsWith('{');
      console.log(`[${res.status}] ${url.split('/').slice(-2).join('/')} (${ct.slice(0,40)}): ${isJson ? body.slice(0,300) : body.slice(0,80).replace(/\s+/g,' ')}`);
    } catch (e) {
      console.log(`[ERR] ${url.split('/').pop()}: ${e.message.slice(0,60)}`);
    }
    await sleep(200);
  }
}

probe13()
  .then(() => { console.log('\nProbe 13 complete.'); process.exit(0); })
  .catch(e => { console.error('Probe 13 error:', e.message); process.exit(1); });
