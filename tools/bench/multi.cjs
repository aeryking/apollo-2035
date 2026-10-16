// 用多种视口/DPR 组合测试底图是否绘制
const { chromium } = require(process.env.PWC || 'playwright-core');
const cases = [
  { name: 'A-1440x900-dpr1', w: 1440, h: 900, dpr: 1 },
  { name: 'B-1280x800-dpr2', w: 1280, h: 800, dpr: 2 },
  { name: 'C-800x600-dpr1', w: 800, h: 600, dpr: 1 },
  { name: 'D-1920x1080-dpr1', w: 1920, h: 1080, dpr: 1 },
];
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
  for (const c of cases) {
    const page = await browser.newPage({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: c.dpr });
    await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(11000);
    const cdp = await page.context().newCDPSession(page);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = `/tmp/a35probe/multi-${c.name}.png`;
    require('fs').writeFileSync(f, Buffer.from(data, 'base64'));
    // 采样中心区域平均亮度，用来判断有没有画出东西
    const stat = await page.evaluate(() => {
      const cv = document.querySelector('canvas');
      if (!cv) return 'no canvas';
      return { w: cv.width, h: cv.height, cw: cv.clientWidth, ch: cv.clientHeight, dpr: devicePixelRatio, gl: !!cv.getContext('webgl') };
    });
    console.log(c.name, JSON.stringify(stat), '→', f);
    await page.close();
  }
  await browser.close();
})();
