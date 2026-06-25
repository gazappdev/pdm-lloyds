'use strict';

// Toytown diagnostic — set TEST_TOYTOWN=1 in Bisect env to run.
// Logs raw HTML excerpt and parser results so we can see what the
// server actually returns vs what Chrome's rendered DOM showed.

const ORIGIN = 'https://www.toytownstores.com';

async function run() {
  console.log('[test-toytown] Fetching /sale ...');

  const res = await fetch(`${ORIGIN}/sale`, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
      'Cache-Control':   'no-cache',
    },
  });

  console.log(`[test-toytown] HTTP ${res.status}  Content-Type: ${res.headers.get('content-type')}`);

  const html = await res.text();
  console.log(`[test-toytown] Response body length: ${html.length} chars`);

  // Check for key patterns
  const productDivCount = (html.match(/parent_product_id_/g) || []).length;
  const productClassCount = (html.match(/class="product product--/g) || []).length;
  const hasTitle = html.includes('<title>');
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const hasCaptcha  = /captcha|robot|verify|challenge|cloudflare/i.test(html);
  const hasIncapsula = /incapsula|imperva|pardon our interruption/i.test(html);

  console.log(`[test-toytown] parent_product_id_ occurrences : ${productDivCount}`);
  console.log(`[test-toytown] class="product product--" occurrences: ${productClassCount}`);
  console.log(`[test-toytown] Page title: ${titleMatch ? titleMatch[1] : '(none)'}`);
  console.log(`[test-toytown] CAPTCHA/bot challenge detected: ${hasCaptcha}`);
  console.log(`[test-toytown] Incapsula detected: ${hasIncapsula}`);

  // Print first 3000 chars so we can see what was returned
  console.log('\n[test-toytown] --- HTML HEAD (first 3000 chars) ---');
  console.log(html.slice(0, 3000));

  // If products found, print first segment around one product div
  if (productDivCount > 0) {
    const idx = html.indexOf('parent_product_id_');
    console.log('\n[test-toytown] --- FIRST PRODUCT SEGMENT (500 chars) ---');
    console.log(html.slice(Math.max(0, idx - 50), idx + 500));
  } else {
    // Look for any <div class="product" pattern at all
    const anyProduct = html.indexOf('class="product');
    if (anyProduct !== -1) {
      console.log('\n[test-toytown] --- NEAREST "product" class (500 chars) ---');
      console.log(html.slice(anyProduct, anyProduct + 500));
    }

    // Check if there's an AJAX/API endpoint hint in the HTML
    const ajaxMatches = [...html.matchAll(/\/ajax\/[^\s"'<>]+/g)].map(m => m[0]).slice(0, 10);
    console.log('\n[test-toytown] AJAX endpoint hints:', ajaxMatches);

    // Check for JavaScript-rendered product loader hints
    const jsLoaderHints = [...html.matchAll(/product[_-]?list|getProducts|loadProducts|categoryProducts/gi)].map(m => m[0]).slice(0, 5);
    console.log('[test-toytown] JS product-loader hints:', jsLoaderHints);
  }

  console.log('[test-toytown] Done.');
  process.exit(0);
}

run().catch(err => {
  console.error('[test-toytown] Error:', err.message);
  process.exit(1);
});
