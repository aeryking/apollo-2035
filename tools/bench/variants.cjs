// 变换 GPU 后端与浏览器标志，定位瓦片不绘制的原因
const { chromium } = require(process.env.PWC || 'playwright-core');
const variants = [
  { name: 'default-metal', args: ['--enable-gpu', '--ignore-gpu-blocklist'] },
  { name: 'swiftshader', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  { name: 'nofeatures', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-features=IsolateSandboxedIframes,ThirdPartyStoragePartitioning,OptimizationHints'] },
  { name: 'headed-like', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'] },
];
(async () => {
  for (const v of variants) {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: v.args });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    let errs = [];
    page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
    await page.goto('http://localhost:5173/v1test.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(11000);
    const cdp = await page.context().newCDPSession(page);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(`/tmp/a35probe/var-${v.name}.png`, Buffer.from(data, 'base64'));
    const info = await page.evaluate(() => {
      const cv = document.querySelector('canvas');
      const gl = cv && cv.getContext('webgl');
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL), canvas: cv && [cv.width, cv.height] };
    });
    console.log(v.name, JSON.stringify(info), errs.join('|') || '');
    await browser.close();
  }
})();
