// 打开页面，等待若干秒后截图（headed 模式用于人工核对渲染效果）
const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const url = process.argv[2];
  const secs = Number(process.argv[3] || 20);
  const out = process.argv[4];
  const browser = await chromium.launch({ channel: 'chrome', headless: !process.env.HEADED, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(secs * 1000);
  // 直接走 CDP 截图：持续重绘的 WebGL 页面上 page.screenshot 偶尔会一直等不到稳定帧
  if (out) {
    const cdp = await page.context().newCDPSession(page);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(out, Buffer.from(data, 'base64'));
  }
  console.log(JSON.stringify(await page.evaluate(() => ({
    zoom: window.__map?.getZoom(), cars: window.__layer?.totalCount, visible: window.__layer?.visibleCount,
    filled: window.__layer?.parts.map(p => p.filled), fps: document.getElementById('p-fps')?.textContent,
  }))));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
