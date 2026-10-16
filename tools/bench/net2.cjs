// 抓上下文级别全部请求（含 Worker 发出的请求）与 Worker 生命周期
const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  ctx.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url().slice(0, 200)); });
  ctx.on('requestfailed', (r) => console.log('FAILED', r.failure()?.errorText, r.url().slice(0, 200)));
  page.on('worker', (w) => {
    console.log('WORKER +', w.url().slice(0, 120));
    w.on('console', (m) => console.log('  [worker]', m.type(), m.text().slice(0, 200)));
  });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text().slice(0, 250), JSON.stringify(m.location())); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 250)));
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(Number(process.argv[3] || 12000));
  await browser.close();
})();
