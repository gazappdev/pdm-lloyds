'use strict';

// chrome-headless-shell: stripped headless-only build, much smaller than full chrome
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
  console.log(`install() returned executablePath: ${result.executablePath}`);

  if (fs.existsSync(result.executablePath)) {
    console.log(`VERIFIED: ${BROWSER} binary present.`);
  } else {
    console.warn(`WARN: binary not found at expected path: ${result.executablePath}`);
    // List what IS in the build directory so we can see the actual structure
    const buildDir = path.dirname(result.executablePath);
    const parent   = path.dirname(buildDir);
    if (fs.existsSync(parent)) {
      console.warn('parent dir contents:', fs.readdirSync(parent).join(', '));
    }
    if (fs.existsSync(buildDir)) {
      console.warn('build dir contents:', fs.readdirSync(buildDir).join(', '));
    } else {
      console.warn('build dir does not exist:', buildDir);
    }
    // Exit 0 so npm install succeeds — bot may use system Chrome instead
  }
})().catch(err => {
  // Non-fatal: log error but let npm install succeed so bot can try system Chrome
  console.warn(`WARN: ${BROWSER} install failed: ${err.message}`);
});
