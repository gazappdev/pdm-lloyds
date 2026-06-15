'use strict';

// Run with: node scripts/test-boots.js  OR  set TEST_BOOTS=1 in Bisect env and restart.
// Purpose : probe boots.com to determine reachability and API structure from this host.
//
// FINDINGS SO FAR (run 1):
//   - HTML category page → Incapsula JS challenge (6183 bytes). IP is NOT blocked; challenge is JS-based.
//   - Wrong API paths return real WCS 937KB 404 pages → they pass through Incapsula.
//   - Platform: IBM WebSphere Commerce (storeId=11352, catalogId=28501).
//   - This run: probe correct WCS REST API paths + attempt cookie carry-over.

const CATEGORY_URL = 'https://www.boots.com/beauty/skincare/skincare-savings';
const ORIGIN       = 'https://www.boots.com';
const STORE_ID     = '11352';
const CATALOG_ID   = '28501';

// Incapsula session cookie from run 1 — may help carry state on second request.
// If a new cookie is set in run 2, update this value for run 3.
const INCAP_COOKIE = 'incap_ses_1398_949787=dqLLO/teXD/uJI65yLFmE24iMGoAAAAA6YMEDSXUg94w4sb7wztHWw==';

const BROWSER_HEADERS = {
  'Accept':                    'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language':           'en-GB,en;q=0.9',
  'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Cache-Control':             'no-cache',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
  'Upgrade-Insecure-Requests': '1',
};

const JSON_HEADERS = {
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Cache-Control':   'no-cache',
};

const hr = () => console.log('─'.repeat(70));

// Collect cookies across requests to carry Incapsula state forward.
const cookieJar = new Map();

function applyJar(headers) {
  const entries = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return entries ? { ...headers, Cookie: entries } : headers;
}

function harvestCookies(res) {
  // Node fetch doesn't expose set-cookie as array, use raw header
  const raw = res.headers.get('set-cookie') || '';
  for (const part of raw.split(',')) {
    const kv = part.trim().split(';')[0];
    const eq = kv.indexOf('=');
    if (eq > 0) cookieJar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
  }
}

// Seed jar with cookie from run 1
for (const part of INCAP_COOKIE.split(';')) {
  const eq = part.indexOf('=');
  if (eq > 0) cookieJar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
}

async function probe(label, url, headers, expectJson = false) {
  hr();
  console.log(`TEST : ${label}`);
  console.log(`URL  : ${url}`);
  try {
    const res = await fetch(url, { headers: applyJar(headers), redirect: 'follow' });
    harvestCookies(res);
    console.log(`Status : ${res.status} ${res.statusText}`);

    for (const h of ['content-type', 'set-cookie', 'server', 'x-powered-by']) {
      const v = res.headers.get(h);
      if (v) console.log(`Header : ${h}: ${v.slice(0, 150)}`);
    }

    const text = await res.text();
    console.log(`Body len : ${text.length} chars`);

    // Incapsula challenge detection
    if (text.includes('_Incapsula_Resource') || text.includes('reeseSkipExpirationCheck') || text.includes('Pardon Our Interruption')) {
      console.log('⚠️  INCAPSULA CHALLENGE — JS execution required');
      return { status: res.status, blocked: true, text };
    }

    if (expectJson || res.headers.get('content-type')?.includes('json')) {
      try {
        const data = JSON.parse(text);
        console.log('✅ Valid JSON. Top-level keys:', Object.keys(data).join(', '));
        const raw = JSON.stringify(data);
        const hits = (raw.match(/"price"|"sku"|"productId"|"partNumber"|"name"/g) || []).length;
        if (hits) console.log(`   ⭐ product-like keys hit ${hits} times`);
        console.log('Response (first 3000 chars):\n', text.slice(0, 3000));
        return { status: res.status, blocked: false, json: data, text };
      } catch {
        console.log('Content-type is JSON but body did not parse. First 600:\n', text.slice(0, 600));
      }
    } else {
      // HTML — look for useful signals
      if (text.includes('__NEXT_DATA__')) {
        const m = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        console.log('✅ __NEXT_DATA__ found:\n', m ? m[1].slice(0, 3000) : '(no match)');
      }
      const apiRefs = [...new Set([...text.matchAll(/["'](\/(?:wcs|api|rest)[^"'?#\s]{4,80})/g)].map(m => m[1]))];
      if (apiRefs.length) {
        console.log('✅ API paths in page:');
        apiRefs.slice(0, 20).forEach(u => console.log('  ', u));
      }
      const categoryIds = [...text.matchAll(/categoryId[=:]["']?(\d{5,20})/g)].map(m => m[1]);
      if (categoryIds.length) console.log('✅ Category IDs found:', [...new Set(categoryIds)].join(', '));
      console.log('Body (first 2000):\n', text.slice(0, 2000));
    }
    return { status: res.status, blocked: false, text };
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    return { status: null, blocked: null };
  }
}

(async () => {
  console.log('Boots.com probe script — RUN 2 (WCS API focus)');
  console.log('Date        :', new Date().toISOString());
  console.log('Node version:', process.version);
  console.log('Seeded cookie jar with incap_ses from run 1.\n');

  // ── 1. Category page again (with prior incap cookie) ───────────────────
  await probe('Category page WITH incap cookie', CATEGORY_URL, BROWSER_HEADERS);

  // ── 2. WCS REST API — product search (most likely to work) ─────────────
  // WCS Commerce REST API: /wcs/resources/store/{storeId}/productview/...
  await probe(
    'WCS productview bySearchTerm: skincare savings',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/productview/bySearchTerm/*?searchTerm=skincare+savings&pageSize=24&pageNumber=1&lang=-1&currency=GBP`,
    JSON_HEADERS, true
  );

  // ── 3. WCS category listing ─────────────────────────────────────────────
  await probe(
    'WCS categoryview top-level (get category IDs)',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/categoryview/@top?depthAndLimit=2,10&lang=-1`,
    JSON_HEADERS, true
  );

  // ── 4. WCS SEO URL → category ID resolver ──────────────────────────────
  await probe(
    'WCS SEO URL token resolver',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/seo/token?q=%2Fbeauty%2Fskincare%2Fskincare-savings`,
    JSON_HEADERS, true
  );

  // ── 5. WCS Ajax product listing servlet ────────────────────────────────
  await probe(
    'WCS AjaxProductListingView servlet (search)',
    `${ORIGIN}/webapp/wcs/stores/servlet/AjaxProductListingView?storeId=${STORE_ID}&catalogId=${CATALOG_ID}&searchTerm=skincare+savings&pageSize=24&pageNumber=1&langId=-1`,
    JSON_HEADERS, true
  );

  // ── 6. WCS category servlet (JSON variant) ─────────────────────────────
  await probe(
    'WCS CategoryDisplay servlet',
    `${ORIGIN}/webapp/wcs/stores/servlet/CategoryDisplay?storeId=${STORE_ID}&catalogId=${CATALOG_ID}&langId=-1&identifier=beauty-skincare-savings`,
    BROWSER_HEADERS
  );

  // ── 7. WCS product view by category identifier ─────────────────────────
  await probe(
    'WCS productview byCategory identifier',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/productview/byCategory/beauty-skincare-savings?pageSize=24&pageNumber=1&lang=-1`,
    JSON_HEADERS, true
  );

  // ── 8. WCS product search with catalog ─────────────────────────────────
  await probe(
    'WCS productview bySearchTerm: skincare-savings (exact slug)',
    `${ORIGIN}/wcs/resources/store/${STORE_ID}/productview/bySearchTerm/*?searchTerm=skincare-savings&pageSize=24&pageNumber=1&lang=-1&catalogId=${CATALOG_ID}`,
    JSON_HEADERS, true
  );

  // ── 9. WCS Elasticsearch / Search REST ─────────────────────────────────
  await probe(
    'WCS Search REST API',
    `${ORIGIN}/search/resources/store/${STORE_ID}/productview/bySearchTerm/*?searchTerm=skincare+savings&pageSize=24&pageNumber=1&lang=-1`,
    JSON_HEADERS, true
  );

  hr();
  console.log('Current cookie jar:');
  for (const [k, v] of cookieJar.entries()) console.log(`  ${k}=${v.slice(0, 60)}`);

  hr();
  console.log('PROBE COMPLETE');
  process.exit(0);
})();
