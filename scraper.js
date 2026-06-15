'use strict';

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
require('dotenv').config();

// One-shot diagnostic mode: set TEST_BOOTS=1 in Bisect env, restart, read console, then remove it.
if (process.env.TEST_BOOTS === '1') {
  require('./scripts/test-boots.js');
  return;
}

const lloyds = require('./stores/lloyds');

// Stores run sequentially. Add more pharmacy/health stores here in future.
const STORES = [lloyds];

const MONITOR_WEBHOOK_URL   = process.env.MONITOR_WEBHOOK_URL       || '';
const SCRAPESHEET_WEBHOOK   = process.env.SCRAPESHEET_WEBHOOK_URL   || '';
const SCRAPESHEET_WEBHOOK_2 = process.env.SCRAPESHEET_WEBHOOK_URL_2 || '';

const sleep   = ms => new Promise(r => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function formatUK(ts = new Date()) {
  const d = ts.toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const [date, time] = d.split(', ');
  const [dd, mm, yyyy] = date.split('/');
  return `${yyyy}-${mm}-${dd} @ ${time}`;
}

// ===== MONITOR =====
async function sendMonitor(content) {
  if (!MONITOR_WEBHOOK_URL) return;
  try {
    await fetch(MONITOR_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content }),
    });
  } catch (err) { console.error('Monitor post failed:', err.message); }
}

async function sendStartStop(status) {
  const symbol = status === 'start' ? '🟢' : '🛑';
  const text   = status === 'start' ? 'Bot started' : 'Bot stopping';
  await sendMonitor(`**Lloyds Pharmacy PDM** — ${symbol} ${text} ${formatUK()}`);
}

// ===== SCAN SUMMARY =====
async function postStoreSummary(stats, scanDurStr, delayMins, nextTimeFull) {
  if (!MONITOR_WEBHOOK_URL) return;

  const catChanges = [];
  if (stats.newCats?.length)     catChanges.push(`🆕 New categories: ${stats.newCats.map(c => c.name).join(', ')}`);
  if (stats.missingCats?.length) catChanges.push(`❌ Missing categories: ${stats.missingCats.map(c => c.name).join(', ')}`);

  // Only list categories with activity — listing all quietly-scanned collections
  // exceeds Discord's 4096-char embed description limit for large stores.
  const totalCats  = (stats.categorySummary || []).length;
  const activeCats = (stats.categorySummary || []).filter(c => c.error || c.new || c.drops);
  let catLines = '';
  if (activeCats.length > 0) {
    catLines = activeCats.map(c => {
      if (c.error) return '`' + c.label + '` ⚠️ error';
      const parts = [];
      if (c.drops) parts.push(`📉 ${c.drops}`);
      if (c.new)   parts.push(`🆕 ${c.new}`);
      return '`' + c.label + '`' + (parts.length ? ' — ' + parts.join('  ') : '');
    }).join('\n');
  }

  let description = (
    (stats.coldStart ? `⚠️ **Cold start — ${stats.coldStartPreviewSent} preview posts sent for verification. Remaining deals cached silently. Next run posts normally.**\n──────────────────────────────\n` : '') +
    `**📄 Pages scraped:** ${stats.pagesScraped}\n` +
    `**📊 Unique products seen:** ${stats.uniqueSeen} across ${totalCats} categories\n` +
    `**🆕 New deals found:** ${stats.totNew}${stats.coldStart ? ` (${stats.coldStartPreviewSent} posted, rest cached silently)` : ''}\n` +
    `**📉 Price drops:** ${stats.totPriceDrops}\n` +
    `**❌ OOS:** ${stats.totOos}\n` +
    `**💾 Total cached:** ${stats.totalCached}\n` +
    `**➡️ Sent to Discord:** ${stats.coldStart ? stats.coldStartPreviewSent : stats.totNew + stats.totPriceDrops}\n` +
    `──────────────────────────────\n` +
    (catChanges.length ? catChanges.join('\n') + '\n──────────────────────────────\n' : '') +
    (catLines          ? catLines              + '\n──────────────────────────────\n' : '') +
    `⏱️ Scan duration: **${scanDurStr}**\n` +
    `⏳ Next run in **${delayMins}** minutes at **${nextTimeFull}**`
  );

  // Hard cap at Discord's 4096-char limit
  if (description.length > 4000) description = description.slice(0, 3990) + '\n*(trimmed)*';

  const embed = {
    color:  stats.color || 0x98BD0D,
    author: { name: `${stats.storeName} PDM — Scan Complete` },
    description,
  };

  const logoFile = stats.logoFile || null;
  const hasLogo  = logoFile && fs.existsSync(logoFile);
  if (hasLogo) embed.thumbnail = { url: `attachment://${path.basename(logoFile)}` };

  try {
    let res;
    if (hasLogo) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ embeds: [embed] }));
      form.append('files[0]', new Blob([fs.readFileSync(logoFile)], { type: 'image/png' }), path.basename(logoFile));
      res = await fetch(MONITOR_WEBHOOK_URL, { method: 'POST', body: form });
    } else {
      res = await fetch(MONITOR_WEBHOOK_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ embeds: [embed] }),
      });
    }
    if (res.ok) {
      console.log(`Posted run summary for ${stats.storeName}.`);
    } else {
      const body = await res.text().catch(() => '');
      console.error(`Run summary post failed: HTTP ${res.status}`, body.slice(0, 300));
    }
  } catch (err) { console.error('Failed to post summary:', err.message); }
}

// ===== MAIN LOOP =====
async function runLoop() {
  console.log('Lloyds Pharmacy PDM starting...');
  await sendStartStop('start');
  console.log('successfully finished startup'); // required by Bisect to mark server online

  while (true) {
    const delayMins = randInt(120, 300);
    const nextRun   = new Date(Date.now() + delayMins * 60 * 1000);
    const nextTimeFull = nextRun.toLocaleTimeString('en-GB', {
      timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    const cycleStart = Date.now();

    for (const store of STORES) {
      const storeStart = Date.now();
      let stats;
      try {
        stats = await store.scan();
      } catch (err) {
        console.error(`[${store.config.name}] Scan crashed:`, err.message, err.stack);
        await sendMonitor(`⚠️ **${store.config.name}** scan crashed: ${err.message}`);
        continue;
      }
      const storeSecs = Math.round((Date.now() - storeStart) / 1000);
      const durStr    = `${Math.floor(storeSecs / 60)}m ${storeSecs % 60}s`;
      await postStoreSummary(stats, durStr, delayMins, nextTimeFull);
    }

    const totalSecs = Math.round((Date.now() - cycleStart) / 1000);
    console.log(`Scan done in ${Math.floor(totalSecs / 60)}m ${totalSecs % 60}s. Next run in ${delayMins} min at ${nextTimeFull}.`);
    await sleep(delayMins * 60 * 1000);
  }
}

// ===== ERROR HANDLING =====
process.on('unhandledRejection', reason => console.error('UNHANDLED REJECTION:', reason));
process.on('uncaughtException',  err    => console.error('UNCAUGHT EXCEPTION:', err.message, err.stack));

runLoop().catch(err => {
  console.error('runLoop crashed:', err.message, err.stack);
  process.exit(1);
});

// Hourly heartbeat
cron.schedule('0 * * * *', async () => {
  await sendMonitor(
    `**Lloyds Pharmacy PDM** — Online ${new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })}`
  ).catch(() => {});
}, { timezone: 'Europe/London' });

// Daily CSV export at 06:01
cron.schedule('1 6 * * *', async () => {
  for (const store of STORES) {
    try {
      await store.exportCSV(SCRAPESHEET_WEBHOOK, SCRAPESHEET_WEBHOOK_2);
    } catch (err) { console.error(`CSV export failed for ${store.config.name}:`, err.message); }
  }
}, { timezone: 'Europe/London' });

// Graceful shutdown
let stopping = false;
async function gracefulStop(signal) {
  if (stopping) return;
  stopping = true;
  console.warn(`Received ${signal}, shutting down...`);
  await sendStartStop('stop').catch(err => console.error('Failed stop alert:', err.message));
  setTimeout(() => process.exit(0), 2000);
}
process.once('SIGTERM', () => gracefulStop('SIGTERM'));
process.once('SIGINT',  () => gracefulStop('SIGINT'));
