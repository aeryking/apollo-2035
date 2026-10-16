// 渐进打开图层，逐步截图，定位画面消失的时刻
const { chromium } = require(process.env.PWC || 'playwright-core');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => { if (/\[gl\]|上下文|context/i.test(m.text())) console.log('[console]', m.text()); });
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  const cdp = await page.context().newCDPSession(page);
  for (let i = 1; i <= 6; i++) {
    await page.waitForTimeout(8000);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`/tmp/a35probe/prog-${i}.png`, Buffer.from(data, 'base64'));
    const info = await page.evaluate(() => {
      const cv = document.querySelector('#map canvas');
      const gl = cv && (cv.getContext('webgl') || cv.getContext('experimental-webgl'));
      return { lost: gl ? gl.isContextLost() : 'n/a', cl: window.__state?.contextLost || 0, cars: window.__layers?.vehicleLayer?.totalCount, segs: window.__layers?.roadLayer?.segments, zone: window.__layers?.zoneLayer?.fillCount };
    });
    console.log(`t+${i * 8}s`, JSON.stringify(info));
  }
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
