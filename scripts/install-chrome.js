'use strict';

// chrome-headless-shell: ~40MB binary vs ~200MB for full chrome.
// Full chrome extraction exhausts Bisect container disk space.
const { install, detectBrowserPlatform, resolveBuildId } = require('@puppeteer/browsers');
const path = require('path');
const fs   = require('fs');

const BROWSER  = 'chrome-headless-shell';
const cacheDir = path.join(process.cwd(), '.cache', 'puppeteer');

(async () => {
  const platform = detectBrowserPlatform();
  const buildId  = await resolveBuildId(BROWSER, platform, 'stable');
  console.log(`Installing ${BROWSER} ${buildId} (${platform}) to ${cacheDir} ...`);

  const result = await install({
    browser: BROWSER,
    buildId,
    cacheDir,
    downloadProgressCallback(downloaded, total) {
      if (total > 0) process.stdout.write(`\rDownloading: ${Math.round(downloaded / total * 100)}%`);
    },
  });

  process.stdout.write('\n');
  console.log('executablePath:', result.executablePath);

  if (fs.existsSync(result.executablePath)) {
    console.log(`${BROWSER} binary verified.`);
  } else {
    console.error(`ERROR: ${BROWSER} binary missing after install.`);
    const buildDir = path.dirname(result.executablePath);
    const parent   = path.dirname(buildDir);
    if (fs.existsSync(parent)) console.error('Contents of', parent + ':', fs.readdirSync(parent).join(', '));
    if (fs.existsSync(buildDir)) console.error('Contents of', buildDir + ':', fs.readdirSync(buildDir).join(', '));
    process.exit(1);
  }
})().catch(err => {
  console.error('Install failed:', err.message);
  process.exit(1);
});
