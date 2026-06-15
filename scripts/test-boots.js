'use strict';

// Historical probe script — runs 1-9 used to reverse-engineer Boots WCS API.
// Key findings:
//   Platform:         IBM WebSphere Commerce. storeId=11352, catalogId=28501.
//   Category API:     /search/resources/store/11352/productview/byCategory/{numericId}
//   EAN:              attributes.find(identifier==="barcode").values[0].value — 100% populated
//   Prices:           Display/L = current sale price, Offer/I = was/normal price
//   Product URL:      sKUs[0].seo_token_ntk.split(';')[0] from search byId endpoint
//   Images:           https://boots.scene7.com/is/image/Boots/{partNumber}
//   Incapsula:        blocks HTML + text category slugs; numeric IDs on /search/resources bypass it
//   Category IDs:
//     Skincare Savings   2608697   (beauty & skincare → skincare → skincare savings)
//     Toiletries Offers  1595059   (toiletries → toiletries offers)
//     Fragrance Offers   1595046   (fragrance → fragrance offers)
//     Electrical Offers  1595111   (electrical → electrical offers)
//     Hair               1595040   (beauty & skincare → hair)
//
// To run new diagnostics: update this file and set TEST_BOOTS=1 on Bisect.

console.log('test-boots.js: no active probe. Remove TEST_BOOTS=1 from Bisect env to resume normal scanning.');
process.exit(0);
