'use strict';

// Run with: TEST_BOOTS=1 on Bisect.
// Purpose: find category IDs for toiletries, fragrance, electrical, beauty/hair.
// Run 8 found: top-level has "Shop by department" [1590591] and "Offers" [2357689].
// Departments (beauty, toiletries, etc.) must be children of one of those.

const ORIGIN   = 'https://www.boots.com';
const STORE_ID = '11352';

const API_HEADERS = {
  'Accept':          'application/json, */*;q=0.9',
  'Accept-Language': 'en-GB,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Cache-Control':   'no-cache',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hr    = () => console.log('─'.repeat(70));

// Target leaf-node name fragments to locate
const TARGETS = [
  'toiletries-offers',
  'fragrance-offers',
  'electrical-offers',
  'hair',
];

async function getChildren(parentId) {
  const url = `${ORIGIN}/search/resources/store/${STORE_ID}/categoryview/byParentCategory/${parentId}?langId=-1`;
  try {
    const res = await fetch(url, { headers: API_HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.catalogGroupView || []).map(c => ({
      id:    c.uniqueID,
      name:  (c.name || '').trim(),
      token: (c.seo_token_ntk || '').trim(),
    }));
  } catch { return []; }
}

function hit(cat, fragment) {
  const combined = (cat.name + ' ' + cat.token).toLowerCase();
  return combined.includes(fragment.toLowerCase().replace(/-/g, ' '))
      || combined.includes(fragment.toLowerCase());
}

(async () => {
  console.log('Boots.com probe — RUN 9 (drill Shop by dept + Offers)');
  console.log('Date:', new Date().toISOString());

  const found = {};

  // ── Drill "Shop by department" [1590591] ────────────────────────────────
  hr();
  console.log('Children of "Shop by department" [1590591]:');
  const depts = await getChildren('1590591');
  depts.forEach(c => console.log(`  [${c.id}] ${c.name}  token:${c.token}`));

  // For each dept, get its children and look for offer-type subcategories
  for (const dept of depts) {
    await sleep(250);
    const subs = await getChildren(dept.id);
    const offerSubs = subs.filter(c =>
      TARGETS.some(t => hit(c, t))
    );
    if (offerSubs.length > 0) {
      offerSubs.forEach(c => {
        console.log(`  ✅ ${dept.name} → [${c.id}] ${c.name}  token:${c.token}`);
        for (const t of TARGETS) {
          if (hit(c, t) && !found[t]) found[t] = { id: c.id, label: `${c.name}` };
        }
      });
    }

    // "hair" may be a direct dept child, not a sub-offers page
    if (TARGETS.some(t => hit(dept, t))) {
      console.log(`  ✅ DEPT LEVEL: [${dept.id}] ${dept.name}  token:${dept.token}`);
      for (const t of TARGETS) {
        if (hit(dept, t) && !found[t]) found[t] = { id: dept.id, label: dept.name };
      }
    }
  }

  // ── Drill "Offers" [2357689] ────────────────────────────────────────────
  hr();
  console.log('Children of "Offers" [2357689]:');
  await sleep(300);
  const offerCats = await getChildren('2357689');
  offerCats.forEach(c => console.log(`  [${c.id}] ${c.name}  token:${c.token}`));

  for (const cat of offerCats) {
    for (const t of TARGETS) {
      if (hit(cat, t) && !found[t]) {
        console.log(`  ✅ OFFERS → [${cat.id}] ${cat.name}`);
        found[t] = { id: cat.id, label: cat.name };
      }
    }
    // If it's a broad match (e.g. "Toiletries") drill one level deeper for "offers" sub
    const nameFrags = ['toiletries', 'fragrance', 'electrical', 'beauty', 'hair'];
    if (nameFrags.some(f => cat.name.toLowerCase().includes(f))) {
      await sleep(200);
      const subs2 = await getChildren(cat.id);
      const offerSubs2 = subs2.filter(c => TARGETS.some(t => hit(c, t)));
      offerSubs2.forEach(c => {
        console.log(`  ✅ OFFERS→${cat.name} → [${c.id}] ${c.name}`);
        for (const t of TARGETS) {
          if (hit(c, t) && !found[t]) found[t] = { id: c.id, label: c.name };
        }
      });
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  hr();
  console.log('SUMMARY — CATEGORIES entries for stores/boots.js:');
  for (const t of TARGETS) {
    const r = found[t];
    if (r) {
      console.log(`  { id: '${r.id}', label: '${r.label}' },  // ${t}`);
    } else {
      console.log(`  // ❌ NOT FOUND: ${t}`);
    }
  }

  hr();
  console.log('PROBE COMPLETE');
  process.exit(0);
})();
