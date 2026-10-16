// 分视角截图：全国 / 北京 z12 / 北京 z15 倾斜
const { chromium } = require(process.env.PWC || 'playwright-core');
const { launch } = require('./real.cjs');
const fs = require('fs');
(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  const cdp = await page.context().newCDPSession(page);
  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`/tmp/a35probe/view-${name}.png`, Buffer.from(data, 'base64'));
    const info = await page.evaluate(() => ({ zoom: window.__map?.getZoom(), cars: window.__layers?.vehicleLayer?.totalCount, segs: window.__layers?.roadLayer?.segments, zone: window.__layers?.zoneLayer?.fillCount }));
    console.log(name, JSON.stringify(info));
  };
  await page.waitForFunction(() => (window.__layers?.vehicleLayer?.totalCount || 0) > 100000, null, { timeout: 150000, polling: 2000 }).catch(() => console.log('车辆未满'));
  await page.waitForTimeout(3000);
  await shot('nation');
  await page.evaluate(() => window.__map.centerAndZoom(new BMap.Point(116.404, 39.915), 12));
  await page.waitForTimeout(6000);
  await shot('beijing-z12');
  await page.evaluate(() => { window.__map.centerAndZoom(new BMap.Point(116.404, 39.915), 15); window.__map.setTilt(50); window.__map.setHeading(25); });
  await page.waitForTimeout(6000);
  await shot('beijing-z15');
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
