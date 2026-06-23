'use strict';

// Boots WCS reverse-engineering probe archive.
// All probes 1–13 have completed. Key findings:
//
//   Platform:  IBM WebSphere Commerce. storeId=11352, catalogId=28501.
//   Working:   /search/resources/store/11352/productview|categoryview/... with numeric category IDs
//   Blocked:   Incapsula blocks all non-numeric-ID paths and all HTML pages (Error 15 / Pardon Our Interruption)
//
//   Category IDs in production use (stores/boots.js):
//     Skincare Savings   2608697   beauty & skincare → skincare → skincare savings
//     Toiletries Offers  1595059   toiletries → toiletries offers
//     Fragrance Offers   1595046   fragrance → fragrance offers
//     Electrical Offers  1595111   electrical → electrical offers
//     Hair               1595040   beauty & skincare → hair
//
//   Additional IDs discovered (not currently monitored):
//     1595024  = Offers aggregate parent (children: all dept-offer subcategories)
//     1595033  = health offers
//     1595042  = skincare offers
//     1595072  = opticians offers
//     2921187  = makeup offers
//     1595110  = baby & child offers
//
//   /tuesday-offer (£10 Tuesdays) investigation outcome:
//     - NOT a WCS category at any level of the category tree
//     - byIdentifier returns 0 results for all slug variants
//     - Not found in level-1, level-2, or gap-range scans
//     - eSpot API endpoints blocked by Incapsula
//     - Boots website is NOT Next.js — classic WCS storefront with custom React frontend
//     - The page is a CMS/marketing page backed by an unknown promotion mechanism
//     - No programmatic access possible from Bisect's IP due to Incapsula
//     - Future options: scraping proxy service (ScrapingBee/Bright Data) or manual curation
//
// Set TEST_BOOTS=1 on Bisect to run this file (currently a no-op placeholder).

console.log('test-boots: no active probe. Remove TEST_BOOTS env var to run normally.');
process.exit(0);
