'use strict';

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const path = require('path');

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

async function findChromePath() {
  try {
    const { getInstalledBrowsers } = require('@puppeteer/browsers');
    const cacheDir = path.join(__dirname, '..', '.cache', 'puppeteer');
    const browsers = await getInstalledBrowsers({ cacheDir });
    const chrome   = Array.isArray(browsers) && browsers.find(b => b.browser === 'chrome');
    if (chrome) {
      console.log(`[browser] Found Chrome at: ${chrome.executablePath}`);
      return chrome.executablePath;
    }
    console.warn('[browser] No Chrome found in cache:', cacheDir);
  } catch (e) {
    console.warn('[browser] Could not locate Chrome via @puppeteer/browsers:', e.message);
  }
  return undefined;
}

async function launch(opts = {}) {
  const envPath    = (process.env.CHROME_PATH || '').trim();
  const chromePath = envPath || await findChromePath() || undefined;
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
