'use strict';

// Run with: TEST_BOOTS=1 on Bisect.
// Purpose: find numeric category IDs for new categories to add to CATEGORIES array.

const ORIGIN   = 'https://www.boots.com';
const STORE_ID = '11352';

const API_HEADERS = {
  'Accept':          'application/json, */*;q=0.9',
  'Accept-Language': 'en-GB,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Cache-Control':   'no-cache',
};

// Target category paths we want to identify
// Each entry: [depth-1 label fragment, depth-2 label fragment (or null if depth-1 is the target)]
const TARGETS = [
  { slug: 'toiletries/toiletries-offers',  search: ['toiletries', 'offer'] },
  { slug: 'fragrance/fragrance-offers',    search: ['fragrance',  'offer'] },
  { slug: 'electrical/electrical-offers',  search: ['electrical', 'offer'] },
  { slug: 'beauty/hair',                   search: ['beauty',     'hair']  },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hr    = () => console.log('─'.repeat(70));

async function getCategories(parentId) {
  const url = parentId === 'top'
    ? `${ORIGIN}/search/resources/store/${STORE_ID}/categoryview/@top?langId=-1`
    : `${ORIGIN}/search/resources/store/${STORE_ID}/categoryview/byParentCategory/${parentId}?langId=-1`;
  try {
    const res = await fetch(url, { headers: API_HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.catalogGroupView || []).map(c => ({
      id:       c.uniqueID,
      name:     (c.name || '').trim(),
      seoToken: c.seo_token_ntk || '',
    }));
  } catch { return []; }
}

function matches(name, fragment) {
  return name.toLowerCase().includes(fragment.toLowerCase());
}

(async () => {
  console.log('Boots.com probe — RUN 8 (category ID lookup)');
  console.log('Date:', new Date().toISOString());
  hr();

  // 1. Get top-level categories
  console.log('Fetching top-level categories...');
  const topCats = await getCategories('top');
  console.log(`Found ${topCats.length} top-level categories:`);
  topCats.forEach(c => console.log(`  [${c.id}] ${c.name}  (${c.seoToken})`));

  hr();

  const found = {};

  // 2. For each target, find depth-1 match then depth-2 match
  for (const target of TARGETS) {
    const [d1frag, d2frag] = target.search;
    console.log(`\nLooking for: ${target.slug}`);

    const depth1 = topCats.filter(c => matches(c.name, d1frag));
    if (depth1.length === 0) {
      console.log(`  ❌ No top-level category matching "${d1frag}"`);
      continue;
    }

    for (const d1cat of depth1) {
      console.log(`  Depth-1 match: [${d1cat.id}] ${d1cat.name}`);

      if (!d2frag) {
        found[target.slug] = { id: d1cat.id, label: d1cat.name };
        console.log(`  ✅ TARGET FOUND: id=${d1cat.id}  label="${d1cat.name}"`);
        continue;
      }

      await sleep(300);
      const depth2 = await getCategories(d1cat.id);
      console.log(`  Depth-2 (${depth2.length} subcats): ${depth2.map(c => c.name).join(', ')}`);

      const d2match = depth2.filter(c => matches(c.name, d2frag));
      if (d2match.length === 0) {
        // Try one level deeper for each depth-2 category
        console.log(`  No depth-2 match for "${d2frag}" — drilling depth-3...`);
        for (const d2cat of depth2) {
          await sleep(200);
          const depth3 = await getCategories(d2cat.id);
          const d3match = depth3.filter(c => matches(c.name, d2frag));
          if (d3match.length > 0) {
            d3match.forEach(c => {
              console.log(`  ✅ DEPTH-3 MATCH: [${c.id}] ${c.name}  (under ${d2cat.name})`);
              if (!found[target.slug]) found[target.slug] = { id: c.id, label: c.name };
            });
          }
        }
      } else {
        d2match.forEach(c => {
          console.log(`  ✅ TARGET FOUND: id=${c.id}  label="${c.name}"`);
          if (!found[target.slug]) found[target.slug] = { id: c.id, label: c.name };
        });
      }
    }
    await sleep(300);
  }

  hr();
  console.log('\nSUMMARY — add these to CATEGORIES in stores/boots.js:');
  for (const target of TARGETS) {
    const result = found[target.slug];
    if (result) {
      console.log(`  { id: '${result.id}', label: '${result.label}' },  // ${target.slug}`);
    } else {
      console.log(`  // ❌ NOT FOUND: ${target.slug}`);
    }
  }

  hr();
  console.log('PROBE COMPLETE');
  process.exit(0);
})();
