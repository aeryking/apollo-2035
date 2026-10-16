// 演示分幕截图：点击幕按钮后等待，再截图
const { chromium } = require(process.env.PWC || 'playwright-core');
const { launch } = require('./real.cjs');
const fs = require('fs');
(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 200)); });
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window.__layers?.vehicleLayer?.totalCount || 0) > 50000, null, { timeout: 150000, polling: 2000 });
  const cdp = await page.context().newCDPSession(page);
  const acts = (process.argv[3] || 'demand,corridor').split(',');
  for (const act of acts) {
    await page.click(`#acts button[data-act="${act}"]`);
    await page.waitForTimeout(Number(process.env.WAIT || 12000));
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`/tmp/a35probe/act-${act}.png`, Buffer.from(data, 'base64'));
    const info = await page.evaluate(() => ({ zoom: window.__map.getZoom(), hex: window.__layers.hexLayer.count, seg: window.__layers.eventLayer.segCount, amb: window.__layers.eventLayer.amb, yielded: window.__state.yielded, tod: window.__fleet?.tod }));
    console.log(act, JSON.stringify(info));
  }
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
