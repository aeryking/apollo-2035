// 用系统 Chrome 打开探针页，打印 window.__probe；HEADED=1 用有头模式（真实 GPU）
const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const headed = !!process.env.HEADED;
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !headed,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => {
    const t = m.text();
    if (/Failed to load resource/.test(t)) return;
    if (m.type() === 'error' || m.type() === 'warning' || process.env.VERBOSE) console.log('[page]', m.type(), t.slice(0, 400));
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(process.argv[2] || 'http://localhost:5173/probe.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__probe && window.__probe.done, null, { timeout: Number(process.env.WAIT || 60000) });
  const r = await page.evaluate(() => window.__probe);
  console.log(JSON.stringify(r, null, process.env.COMPACT ? 0 : 2));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, timeout: 15000 }).catch((e) => console.log('[screenshot failed]', e.message));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
