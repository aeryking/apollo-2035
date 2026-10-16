const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__layers?.vehicleLayer?.totalCount || 0) > 20000, null, { timeout: 150000, polling: 2000 });
  await page.evaluate(() => { window.__dbgEvent = {}; document.querySelector('#acts button[data-act="corridor"]').click(); });
  await page.waitForTimeout(9000);
  console.log(JSON.stringify(await page.evaluate(() => window.__dbgEvent)));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
