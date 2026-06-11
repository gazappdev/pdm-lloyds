'use strict';

const { install, detectBrowserPlatform, resolveBuildId } = require('@puppeteer/browsers');
const path = require('path');

const cacheDir = path.join(process.cwd(), '.cache', 'puppeteer');

(async () => {
  const platform = detectBrowserPlatform();
  const buildId  = await resolveBuildId('chrome', platform, 'stable');
  console.log(`Installing Chrome ${buildId} to ${cacheDir} ...`);
  await install({
    browser: 'chrome',
    buildId,
    cacheDir,
    downloadProgressCallback(downloaded, total) {
      if (total > 0) process.stdout.write(`\rDownloading Chrome: ${Math.round(downloaded / total * 100)}%`);
    },
  });
  console.log('\nChrome installed successfully.');
})().catch(err => {
  console.error('Chrome install failed:', err.message);
  process.exit(1);
});
