const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 200)); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__probe?.done, null, { timeout: 40000 }).catch(() => console.log('(timeout waiting done)'));
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(process.argv[3], Buffer.from(data, 'base64'));
  console.log(JSON.stringify(await page.evaluate(() => ({ zoom: window.__map?.getZoom(), log: window.__probe?.log }))));
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
