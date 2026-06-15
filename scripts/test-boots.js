'use strict';

// Run with: node scripts/test-boots.js
// Purpose : probe boots.com to determine reachability and API structure from this host.

const CATEGORY_URL = 'https://www.boots.com/beauty/skincare/skincare-savings';
const ORIGIN       = 'https://www.boots.com';

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

async function probeHtml(label, url) {
  hr();
  console.log(`HTML TEST: ${label}`);
  console.log(`URL      : ${url}`);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
    console.log(`Status   : ${res.status} ${res.statusText}`);

    // Print relevant response headers
    for (const h of ['content-type', 'set-cookie', 'x-powered-by', 'x-request-id', 'server', 'cf-ray', 'x-cache']) {
      const v = res.headers.get(h);
      if (v) console.log(`Header   : ${h}: ${v.slice(0, 120)}`);
    }

    const text = await res.text();
    console.log(`Body len : ${text.length} chars`);

    if (res.status !== 200) {
      console.log('Body (first 600):');
      console.log(text.slice(0, 600));
      return { status: res.status, text };
    }

    // --- Incapsula / bot-wall detection ---
    if (text.includes('_Incapsula_Resource') || text.includes('incap_ses')) {
      console.log('⚠️  INCAPSULA CHALLENGE in body — JS execution required to proceed');
    } else {
      console.log('✅ No Incapsula challenge in body');
    }

    // --- Next.js embedded data ---
    const nextData = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextData) {
      console.log('\n✅ __NEXT_DATA__ found (Next.js SSR):');
      const parsed = JSON.parse(nextData[1]);
      // Print structure without full product dump
      console.log('   Keys:', Object.keys(parsed).join(', '));
      const pageProps = parsed?.props?.pageProps;
      if (pageProps) console.log('   pageProps keys:', Object.keys(pageProps).join(', '));
      // Look for product arrays
      const raw = JSON.stringify(pageProps || parsed);
      const prodCount = (raw.match(/"productId"|"sku"|"product_id"/g) || []).length;
      if (prodCount > 0) console.log(`   ⭐ product-like keys found ${prodCount} times in __NEXT_DATA__`);
      console.log('\n__NEXT_DATA__ (first 3000 chars):');
      console.log(nextData[1].slice(0, 3000));
    } else {
      console.log('   No __NEXT_DATA__ found');
    }

    // --- Algolia ---
    if (text.toLowerCase().includes('algolia')) {
      const appId  = text.match(/["']?applicationId["']?\s*[=:]\s*["']([A-Z0-9]{6,12})["']/i)?.[1];
      const apiKey = text.match(/["']?apiKey["']?\s*[=:]\s*["']([a-f0-9]{16,40})["']/i)?.[1];
      const index  = text.match(/["']?indexName["']?\s*[=:]\s*["']([^"']{3,60})["']/i)?.[1];
      console.log(`\n✅ ALGOLIA referenced — appId: ${appId || '?'}  apiKey: ${apiKey || '?'}  index: ${index || '?'}`);
    }

    // --- Embedded JSON-LD ---
    const jsonLds = [...text.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    if (jsonLds.length) {
      console.log(`\n✅ ${jsonLds.length} JSON-LD block(s):`);
      jsonLds.slice(0, 4).forEach((m, i) => {
        try {
          const d = JSON.parse(m[1]);
          const type = d['@type'] || d['@graph']?.[0]?.['@type'] || '?';
          console.log(`   Block ${i + 1}: @type=${type}`);
          if (type === 'Product') console.log('   ⭐ Product JSON-LD found:', JSON.stringify(d).slice(0, 300));
        } catch { console.log(`   Block ${i + 1}: JSON parse error`); }
      });
    }

    // --- API endpoint references ---
    const apiRefs = [...new Set([...text.matchAll(/["'](\/api\/[^"'?#\s]{4,80})/g)].map(m => m[1]))];
    if (apiRefs.length) {
      console.log('\n✅ /api/* paths in page source:');
      apiRefs.slice(0, 25).forEach(u => console.log('  ', u));
    }

    // --- GraphQL ---
    if (text.includes('graphql') || text.includes('GraphQL')) {
      const gql = text.match(/["'](\/[^"']*graphql[^"']*?)["']/i)?.[1];
      console.log(`\n✅ GraphQL endpoint hint: ${gql || 'present (no URL extracted)'}`);
    }

    // --- Body preview ---
    console.log('\nBody (first 1500 chars):');
    console.log(text.slice(0, 1500));

    return { status: res.status, text };
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    return { status: null };
  }
}

async function probeJson(label, url) {
  hr();
  console.log(`API TEST : ${label}`);
  console.log(`URL      : ${url}`);
  try {
    const res = await fetch(url, { headers: JSON_HEADERS, redirect: 'follow' });
    console.log(`Status   : ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`Body len : ${text.length} chars`);
    if (res.status === 200) {
      try {
        const data = JSON.parse(text);
        console.log('✅ Valid JSON. Top-level keys:', Object.keys(data).join(', '));
        // Look for product arrays
        const raw = JSON.stringify(data);
        const count = (raw.match(/"sku"|"productId"|"product_code"|"price"/g) || []).length;
        if (count > 0) console.log(`   ⭐ product-like keys found ${count} times`);
        console.log('Response (first 1500 chars):', text.slice(0, 1500));
      } catch {
        console.log('Body is not JSON. First 600 chars:');
        console.log(text.slice(0, 600));
      }
    } else {
      console.log('Body (first 300):', text.slice(0, 300));
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }
}

(async () => {
  console.log('Boots.com probe script');
  console.log('Date        :', new Date().toISOString());
  console.log('Node version:', process.version);
  console.log('Host IP will appear in any Incapsula error message above.');

  // 1. Main category page (HTML)
  const { text } = await probeHtml('Skincare savings category page', CATEGORY_URL);

  // 2. Hybris / SAP Commerce patterns (common UK retailers)
  await probeJson('Hybris category JSON (?format=json)',         `${ORIGIN}/c/beauty/skincare/skincare-savings?format=json`);
  await probeJson('Hybris REST v2 product search',               `${ORIGIN}/rest/v2/boots/products/search?query=:relevance:category:beauty-skincare-savings&pageSize=24&lang=en&curr=GBP`);
  await probeJson('Hybris REST v2 category',                     `${ORIGIN}/rest/v2/boots/categories/beauty-skincare-savings`);

  // 3. Generic API guesses
  await probeJson('Generic /api/product-listing',                `${ORIGIN}/api/product-listing?categoryId=skincare-savings&pageSize=24`);
  await probeJson('Generic /api/products/search',                `${ORIGIN}/api/products/search?category=beauty-skincare-savings`);
  await probeJson('Generic /api/2.0/page/category',             `${ORIGIN}/api/2.0/page/category?url=/beauty/skincare/skincare-savings`);

  // 4. If HTML loaded, try to find any XHR endpoint embedded in the source
  if (text) {
    const ajaxUrls = [...new Set([
      ...[...text.matchAll(/["'`](https:\/\/www\.boots\.com\/[^"'`\s]{10,120}?(?:json|products|search|catalog|api)[^"'`\s]{0,60})["'`]/g)].map(m => m[1]),
    ])];
    if (ajaxUrls.length) {
      console.log('\n');
      hr();
      console.log(`Found ${ajaxUrls.length} boots.com URL(s) in page source — probing each:`);
      for (const url of ajaxUrls.slice(0, 5)) {
        await probeJson(`Embedded URL: ${url.slice(0, 60)}...`, url);
      }
    }
  }

  hr();
  console.log('PROBE COMPLETE');
  process.exit(0);
})();
