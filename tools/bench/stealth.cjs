// 假设：百度瓦片解码对自动化环境（navigator.webdriver）做了检测，去掉自动化标记再试
const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();
  await page.goto(process.argv[2] || 'http://localhost:5173/v1test.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(Number(process.argv[4] || 12000));
  const cdp = await ctx.newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(process.argv[3] || '/tmp/a35probe/stealth.png', Buffer.from(data, 'base64'));
  console.log('webdriver=', await page.evaluate(() => navigator.webdriver));
  await browser.close();
})();
