'use strict';

// Historical probe script — runs 1-7 used to reverse-engineer the Boots WCS API.
// Key findings:
//   Platform:       IBM WebSphere Commerce. storeId=11352, catalogId=28501.
//   Category API:   /search/resources/store/11352/productview/byCategory/{numericId}
//   Skincare savings category ID: 2608697 (466 products, 20 pages)
//   EAN:            attributes.find(identifier==="barcode").values[0].value — 100% populated
//   Prices:         Display/L = current sale price, Offer/I = was/normal price
//   Product URL:    sKUs[0].seo_token_ntk.split(';')[0] from search byId endpoint
//   Images:         https://boots.scene7.com/is/image/Boots/{partNumber} — confirmed run 7
//   Incapsula:      blocks HTML pages; WCS/search REST API with numeric IDs bypasses it
//
// To re-run diagnostics: update this file and set TEST_BOOTS=1 on Bisect.

console.log('test-boots.js: no active probe. Remove TEST_BOOTS=1 from Bisect env to resume normal scanning.');
process.exit(0);
