const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  for (const q of process.argv.slice(2)) {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 160)));
    await page.goto(`http://localhost:5173/tools/probe/pipeline.html?${q}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__probe?.done, null, { timeout: 240000, polling: 500 }).catch(() => {});
    const r = await page.evaluate(() => window.__probe);
    console.log(q.padEnd(28), JSON.stringify(r));
    await browser.close();
  }
})();
