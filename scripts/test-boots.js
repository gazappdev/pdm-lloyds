'use strict';

// Run with: TEST_BOOTS=1 on Bisect.
// Purpose: find Boots product image URLs via CDN probing + Wayback Machine HTML fallback.
// Runs 1-6 confirmed WCS API has NO images at all for any product.

const ORIGIN   = 'https://www.boots.com';
const STORE_ID = '11352';

// Known product from runs 4-5
const TEST_UNIQUE_ID = '11718';  // parent product
const TEST_SKU_ID    = '11719';  // SKU
const TEST_PART_NUM  = '10033393';
// seo_token from run 5 (eucerin foot cream)
const TEST_SEO_TOKEN = 'eucerin-urearepair-plus-10-urea-foot-cream-100ml-10033393p';

const BROWSER_HEADERS = {
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Cache-Control':   'no-cache',
};
const JSON_HEADERS = { ...BROWSER_HEADERS, Accept: 'application/json, */*;q=0.9' };

const hr = () => console.log('─'.repeat(70));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. Probe image CDN URL patterns ──────────────────────────────────────────
async function probeCdn() {
  hr();
  console.log('SECTION 1: CDN URL probing for part', TEST_PART_NUM);

  // Amplience (adis.ws) is used by many major UK retailers.
  // Scene7 (scene7.com) is another common enterprise image CDN.
  // Boots Alliance may also have media.boots.com or a Cloudinary setup.
  const candidates = [
    // Amplience patterns
    `https://i1.adis.ws/i/boots/${TEST_PART_NUM}`,
    `https://i2.adis.ws/i/boots/${TEST_PART_NUM}`,
    `https://cdn.media.boots.com/i/boots/${TEST_PART_NUM}`,
    `https://media.boots.com/i/boots/${TEST_PART_NUM}`,
    `https://i1.adis.ws/i/boots/${TEST_PART_NUM}_ms`,
    `https://i1.adis.ws/i/boots/walgreens_${TEST_PART_NUM}`,
    // Scene7 patterns
    `https://boots.scene7.com/is/image/Boots/${TEST_PART_NUM}`,
    `https://boots.scene7.com/is/image/boots/${TEST_PART_NUM}`,
    `https://s7.scene7.com/is/image/Boots/${TEST_PART_NUM}`,
    // Other CDN guesses
    `https://assets.boots.com/images/${TEST_PART_NUM}.jpg`,
    `https://cdn.boots.com/images/${TEST_PART_NUM}.jpg`,
    `https://images.boots.com/product/${TEST_PART_NUM}.jpg`,
    // medias with different path patterns
    `${ORIGIN}/medias/${TEST_PART_NUM}.jpg`,
    `${ORIGIN}/medias/${TEST_PART_NUM}-grande.jpg`,
    `${ORIGIN}/medias/${TEST_PART_NUM}-zoom.jpg`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, Accept: 'image/*,*/*' },
        redirect: 'follow',
      });
      const ct = res.headers.get('content-type') || '';
      const loc = res.redirected ? ` → ${res.url}` : '';
      console.log(`  ${res.status} ${ct.slice(0, 30).padEnd(32)} ${url}${loc}`);
      if (res.status === 200 && ct.startsWith('image/')) {
        console.log(`  ⭐⭐⭐ WORKING IMAGE URL: ${res.url}`);
      }
    } catch (err) {
      console.log(`  ERR  ${url}: ${err.message}`);
    }
    await sleep(100);
  }
}

// ── 2. Wayback Machine — get cached boots.com product page HTML ───────────────
async function probeWayback() {
  hr();
  console.log('SECTION 2: Wayback Machine proxy for product page HTML');

  const productPageUrl = `${ORIGIN}/${TEST_SEO_TOKEN}`;
  console.log('Target:', productPageUrl);

  // Ask Wayback availability API
  const avail = await fetch(
    `https://archive.org/wayback/available?url=${encodeURIComponent(productPageUrl)}`,
    { headers: JSON_HEADERS }
  );
  const availJson = await avail.json().catch(() => null);
  console.log('Wayback available:', JSON.stringify(availJson?.archived_snapshots?.closest || 'none'));

  const cached = availJson?.archived_snapshots?.closest;
  if (!cached || !cached.available) {
    console.log('No Wayback cache found for this URL.');
    return;
  }

  console.log('Cached URL:', cached.url, '| Status:', cached.status, '| Timestamp:', cached.timestamp);

  // Fetch the cached page
  await sleep(500);
  const res = await fetch(cached.url, { headers: BROWSER_HEADERS, redirect: 'follow' });
  console.log('Wayback fetch status:', res.status, 'content-type:', res.headers.get('content-type'));

  if (!res.ok) { console.log('Wayback fetch failed.'); return; }

  const html = await res.text();
  console.log('HTML length:', html.length);

  // Extract og:image
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogMatch) {
    console.log('✅ og:image found:', ogMatch[1]);
  } else {
    console.log('No og:image tag found.');
  }

  // Extract first product image src
  const imgMatches = [...html.matchAll(/<img[^>]+src=["']([^"']*(?:product|catalog|media|image)[^"']*)["']/gi)];
  if (imgMatches.length > 0) {
    console.log(`Found ${imgMatches.length} product image src attributes:`);
    imgMatches.slice(0, 8).forEach(m => console.log('  ', m[1]));
  } else {
    console.log('No product <img> tags found.');
  }

  // Any absolute image URLs in the HTML
  const absoluteImgUrls = [...new Set(
    [...html.matchAll(/https:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/gi)].map(m => m[0])
  )];
  console.log(`Absolute image URLs in page (${absoluteImgUrls.length}):`);
  absoluteImgUrls.slice(0, 15).forEach(u => console.log('  ', u));
}

// ── 3. Open Beauty Facts — look up product by EAN ────────────────────────────
async function probeOpenBeautyFacts(ean) {
  hr();
  console.log(`SECTION 3: Open Beauty Facts lookup for EAN ${ean}`);

  try {
    const res = await fetch(
      `https://world.openbeautyfacts.org/api/v3/product/${ean}.json`,
      { headers: { ...JSON_HEADERS, Accept: 'application/json' } }
    );
    console.log('OBF status:', res.status);
    const data = await res.json().catch(() => null);
    if (!data || data.status === 'product not found') {
      console.log('Not found in Open Beauty Facts.');

      // Try Open Food Facts
      await sleep(500);
      const off = await fetch(
        `https://world.openfoodfacts.org/api/v3/product/${ean}.json`,
        { headers: { ...JSON_HEADERS, Accept: 'application/json' } }
      );
      console.log('OFF status:', off.status);
      const offData = await off.json().catch(() => null);
      if (offData?.product?.image_url) {
        console.log('✅ Open Food Facts image:', offData.product.image_url);
        console.log('   image_front_url:', offData.product.image_front_url);
      } else {
        console.log('Not found in Open Food Facts either.');
      }
      return;
    }
    const p = data.product;
    console.log('Found in OBF:', p?.product_name);
    if (p?.image_url)       console.log('✅ image_url:', p.image_url);
    if (p?.image_front_url) console.log('   image_front_url:', p.image_front_url);
    if (!p?.image_url)      console.log('Product found but no image.');
  } catch (err) { console.log('OBF error:', err.message); }
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('Boots.com probe — RUN 7 (CDN + Wayback + Open Beauty Facts)');
  console.log('Date:', new Date().toISOString());

  // First, get the EAN from the API (needed for OBF lookup)
  let ean = null;
  try {
    const r = await fetch(
      `${ORIGIN}/search/resources/store/${STORE_ID}/productview/byId/${TEST_SKU_ID}?lang=-1`,
      { headers: JSON_HEADERS }
    );
    const d = await r.json();
    const attrs = d?.catalogEntryView?.[0]?.attributes || [];
    const bc = attrs.find(a => a.identifier === 'barcode');
    ean = bc?.values?.[0]?.value || null;
    console.log('EAN from API:', ean);
  } catch (err) { console.log('EAN fetch failed:', err.message); }

  await probeCdn();
  await sleep(500);
  await probeWayback();
  await sleep(500);
  if (ean) await probeOpenBeautyFacts(ean);

  hr();
  console.log('PROBE COMPLETE');
  process.exit(0);
})();
