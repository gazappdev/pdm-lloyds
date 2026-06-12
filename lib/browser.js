'use strict';

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const path = require('path');
const fs   = require('fs');

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--window-size=1280,900',
  '--lang=en-GB',
];

function findChromePath() {
  // 1. Check common system Chrome/Chromium paths (Bisect container may have one)
  const systemPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/lib/chromium/chromium',
    '/usr/lib/chromium-browser/chromium-browser',
    '/snap/bin/chromium',
  ];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) {
      console.log(`[browser] Using system Chrome: ${p}`);
      return p;
    }
  }

  // 2. Scan our downloaded cache for chrome-headless-shell
  try {
    const shellDir = path.join(__dirname, '..', '.cache', 'puppeteer', 'chrome-headless-shell');
    if (!fs.existsSync(shellDir)) {
      console.warn('[browser] No chrome-headless-shell cache dir:', shellDir);
      return undefined;
    }
    const builds = fs.readdirSync(shellDir).filter(b => b.startsWith('linux-'));
    console.log(`[browser] chrome-headless-shell builds found: ${builds.join(', ')}`);

    for (const build of builds) {
      const buildPath = path.join(shellDir, build);
      const binary    = path.join(buildPath, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(binary)) {
        console.log(`[browser] Found at: ${binary}`);
        return binary;
      }

      // Log full directory tree so we can see the actual structure
      console.warn(`[browser] Expected binary not found. Listing ${build}/:`);
      try {
        const top = fs.readdirSync(buildPath);
        console.warn(`[browser]   ${buildPath}: ${top.join(', ')}`);
        for (const item of top) {
          const itemPath = path.join(buildPath, item);
          try {
            if (fs.statSync(itemPath).isDirectory()) {
              const sub = fs.readdirSync(itemPath);
              console.warn(`[browser]   ${build}/${item}/: ${sub.join(', ')}`);
            }
          } catch {}
        }
      } catch (e) {
        console.warn(`[browser]   (error listing: ${e.message})`);
      }
    }
    if (builds.length === 0) {
      console.warn('[browser] No linux-* builds in chrome-headless-shell cache');
    }
  } catch (e) {
    console.warn('[browser] Cache scan error:', e.message);
  }
  return undefined;
}

async function launch(opts = {}) {
  const envPath    = (process.env.CHROME_PATH || '').trim();
  const chromePath = envPath || findChromePath() || undefined;
  return puppeteer.launch({
    headless:        process.env.HEADLESS !== 'false',
    executablePath:  chromePath,
    args:            LAUNCH_ARGS,
    defaultViewport: { width: 1280, height: 900 },
    userDataDir:     opts.userDataDir || undefined,
  });
}

async function forceClose(browser) {
  if (!browser) return;
  const proc = browser.process ? browser.process() : null;
  try { await browser.close(); } catch {}
  try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch {}
}

module.exports = { launch, forceClose };
