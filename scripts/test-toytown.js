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

  // Print first 1000 chars so we can see the page head
  console.log('\n[test-toytown] --- HTML HEAD (first 1000 chars) ---');
  console.log(html.slice(0, 1000));

  // Dump the FULL first product segment so we can inspect every attribute/class name
  const segments = html.split(/(?=<div class="product product--)/);
  console.log(`\n[test-toytown] Split segments: ${segments.length} (first is preamble)`);

  const firstProductSeg = segments.find(s => /parent_product_id_/.test(s));
  if (firstProductSeg) {
    console.log(`\n[test-toytown] --- FULL FIRST PRODUCT SEGMENT (${firstProductSeg.length} chars) ---`);
    // Print in 2000-char chunks so nothing gets cut off
    for (let i = 0; i < Math.min(firstProductSeg.length, 6000); i += 2000) {
      console.log(firstProductSeg.slice(i, i + 2000));
      console.log('--- (chunk boundary) ---');
    }

    // Now test each regex individually and report pass/fail
    console.log('\n[test-toytown] --- REGEX TESTS ON FIRST PRODUCT SEGMENT ---');

    const tests = [
      ['product ID',      /parent_product_id_(\d+)/,                                                                      firstProductSeg],
      ['product URL',     /href="(\/[^"]+\-p\d+)"/,                                                                       firstProductSeg],
      ['thumb img src',   /src="(\/images\/[^"]+_thumb\.jpg)"/,                                                            firstProductSeg],
      ['data-src thumb',  /data-src="(\/images\/[^"]+_thumb\.jpg)"/,                                                       firstProductSeg],
      ['SKU ref',         /data-productreference="([^"]+)"/,                                                               firstProductSeg],
      ['details title',   /product__details__title/,                                                                       firstProductSeg],
      ['brand span',      /<span>\s*([\s\S]+?)\s*<\/span>/,          firstProductSeg.slice(firstProductSeg.indexOf('product__details__title') !== -1 ? firstProductSeg.indexOf('product__details__title') : 0, firstProductSeg.indexOf('product__details__title') + 700)],
      ['price--sale cls', /prices__price--sale/,                                                                           firstProductSeg],
      ['price--inc cls',  /product-content__price--inc/,                                                                   firstProductSeg],
      ['GBP class dq',    /class="GBP">/,                                                                                  firstProductSeg],
      ['GBP class sq',    /class='GBP'>/,                                                                                  firstProductSeg],
      ['prices__was cls', /prices__was/,                                                                                   firstProductSeg],
      ['now price full',  /prices__price--sale[\s\S]+?product-content__price--inc[\s\S]+?class="GBP">\s*£([\d.]+)/,       firstProductSeg],
      ['was price full',  /prices__was[\s\S]+?product-content__price--inc[\s\S]+?class="GBP">\s*£([\d.]+)/,               firstProductSeg],
    ];

    for (const [label, re, target] of tests) {
      const m = (target || '').match(re);
      console.log(`  ${m ? '✅' : '❌'} ${label}: ${m ? JSON.stringify(m[1] || m[0]).slice(0, 80) : 'NO MATCH'}`);
    }
  } else {
    console.log('[test-toytown] No product segment found after split — split regex may not match.');
    console.log('First 200 chars of segment[1]:', segments[1] ? segments[1].slice(0, 200) : '(none)');
  }

  console.log('[test-toytown] Done.');
  process.exit(0);
}

run().catch(err => {
  console.error('[test-toytown] Error:', err.message);
  process.exit(1);
});
