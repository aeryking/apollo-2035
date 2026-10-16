const { chromium } = require(process.env.PWC || 'playwright-core');
const { launch } = require('./real.cjs');
const fs = require('fs');
(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__layers?.vehicleLayer?.totalCount || 0) > 50000, null, { timeout: 150000, polling: 2000 });
  await page.evaluate(() => { window.__map.centerAndZoom(new BMap.Point(116.397, 39.908), 16); window.__map.setTilt(45); window.__map.setHeading(15); });
  await page.waitForTimeout(7000);
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(process.argv[3], Buffer.from(data, 'base64'));
  console.log(JSON.stringify(await page.evaluate(() => ({ zoom: window.__map.getZoom(), visible: window.__layers.vehicleLayer.visibleCount, dc: window.__layers.vehicleLayer.stats.draws }))));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
