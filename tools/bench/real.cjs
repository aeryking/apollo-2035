/**
 * 「像真实用户一样」启动 Chrome：
 *  - 去掉 --enable-automation、禁用 AutomationControlled（navigator.webdriver 在页面与 Worker 中都为 false）
 *  - 用普通 Chrome 的 UA（无头模式默认 UA 带 "HeadlessChrome"）
 * 用于验证：百度底图瓦片解码 Worker 是否因检测到自动化环境而拒绝工作。
 */
const { chromium } = require(process.env.PWC || 'playwright-core');
const fs = require('fs');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
async function launch() {
  return chromium.launch({
    channel: 'chrome',
    headless: !process.env.HEADED,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--disable-blink-features=AutomationControlled', `--user-agent=${UA}`, '--enable-precise-memory-info'],
  });
}
module.exports = { launch, UA };
if (require.main === module) {
  (async () => {
    const url = process.argv[2];
    const secs = Number(process.argv[3] || 15);
    const out = process.argv[4] || '/tmp/a35probe/real.png';
    const browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 160)));
    page.on('crash', () => console.log('[page] crash'));
    page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 160)); });
    browser.on('disconnected', () => console.log('[browser] disconnected'));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(secs * 1000);
    const info = await page.evaluate(() => ({ ua: navigator.userAgent.slice(-40), webdriver: navigator.webdriver, zoom: window.__map?.getZoom?.() }));
    const cdp = await page.context().newCDPSession(page);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    console.log(JSON.stringify(info), '→', out);
    await browser.close();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
