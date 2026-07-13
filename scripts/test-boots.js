'use strict';

// Boots live API diagnostic — set TEST_BOOTS=1 in Bisect env to run.
// Fetches the first page of each monitored category and reports:
//   - Whether the API responds
//   - What price usage fields are present on products
//   - How many products have a detectable was-price (Display < Offer)
//   - Sample product data so we can spot format changes

const ORIGIN   = 'https://www.boots.com';
const STORE_ID = '11352';
const PAGE_SIZE = 10;

const CATEGORIES = [
  { id: '2608697', label: 'Skincare Savings' },
  { id: '1595059', label: 'Toiletries Offers' },
  { id: '1595046', label: 'Fragrance Offers' },
  { id: '1595111', label: 'Electrical Offers' },
  { id: '1595040', label: 'Hair' },
];

const HEADERS = {
  'Accept':          'application/json, */*;q=0.9',
  'Accept-Language': 'en-GB,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Cache-Control':   'no-cache',
};

async function run() {
  console.log('[test-boots] Starting Boots API diagnostic...\n');

  for (const cat of CATEGORIES) {
    const url = `${ORIGIN}/search/resources/store/${STORE_ID}/productview/byCategory/${cat.id}?pageSize=${PAGE_SIZE}&pageNumber=1&lang=-1`;
    console.log(`[test-boots] --- ${cat.label} (${cat.id}) ---`);
    console.log(`[test-boots] URL: ${url}`);

    let data;
    try {
      const res = await fetch(url, { headers: HEADERS });
      console.log(`[test-boots] HTTP status: ${res.status}`);
      if (!res.ok) {
        console.warn(`[test-boots] Non-200 response — skipping category`);
        continue;
      }
      data = await res.json();
    } catch (e) {
      console.error(`[test-boots] Fetch failed: ${e.message}`);
      continue;
    }

    const products = data.catalogEntryView || [];
    const total    = data.recordSetTotal || data.recordSetTotalMatches || 0;
    console.log(`[test-boots] Total products in category: ${total} | Returned this page: ${products.length}`);

    if (products.length === 0) {
      console.warn(`[test-boots] No products returned — category may be empty or API format changed`);
      continue;
    }

    // Analyse price fields across all returned products
    let withDisplay = 0, withOffer = 0, withWasPrice = 0, withNeitherPrice = 0;
    const allUsageValues = new Set();

    for (const p of products) {
      const priceArr = p.price || [];
      priceArr.forEach(x => allUsageValues.add(x.usage));

      const displayVal = priceArr.find(x => x.usage === 'Display')?.value;
      const offerVal   = priceArr.find(x => x.usage === 'Offer')?.value;
      const displayNum = displayVal ? parseFloat(displayVal) : NaN;
      const offerNum   = offerVal   ? parseFloat(offerVal)   : NaN;

      if (!isNaN(displayNum)) withDisplay++;
      if (!isNaN(offerNum))   withOffer++;
      if (!isNaN(offerNum) && !isNaN(displayNum) && offerNum > displayNum + 0.005) withWasPrice++;
      if (isNaN(displayNum) && isNaN(offerNum)) withNeitherPrice++;
    }

    console.log(`[test-boots] Price field analysis (${products.length} products):`);
    console.log(`  All usage values present: ${[...allUsageValues].join(', ')}`);
    console.log(`  Has Display price:  ${withDisplay}/${products.length}`);
    console.log(`  Has Offer price:    ${withOffer}/${products.length}`);
    console.log(`  Has was-price (Offer > Display): ${withWasPrice}/${products.length}  ← deals detectable`);
    console.log(`  Has neither price:  ${withNeitherPrice}/${products.length}`);

    // Full price array dump for first 2 products
    console.log(`\n[test-boots] First 2 product price arrays:`);
    for (const p of products.slice(0, 2)) {
      console.log(`  "${(p.name || '').slice(0, 50)}"`);
      console.log(`    price array: ${JSON.stringify(p.price || [])}`);
      console.log(`    buyable: ${p.buyable}`);
    }
    console.log('');
  }

  console.log('[test-boots] Done.');
  process.exit(0);
}

run().catch(err => {
  console.error('[test-boots] Crashed:', err.message);
  process.exit(1);
});
