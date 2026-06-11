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
  try {
    const buildId  = require('puppeteer-core/package.json').puppeteer['chrome-headless-shell'];
    const binary   = path.join(
      __dirname, '..', '.cache', 'puppeteer',
      'chrome-headless-shell', `linux-${buildId}`,
      'chrome-headless-shell-linux64', 'chrome-headless-shell',
    );
    if (fs.existsSync(binary)) {
      console.log(`[browser] Found chrome-headless-shell at: ${binary}`);
      return binary;
    }
    console.warn(`[browser] chrome-headless-shell not found at: ${binary}`);
  } catch (e) {
    console.warn('[browser] findChromePath error:', e.message);
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
