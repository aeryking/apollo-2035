const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
  browser.on('disconnected', () => console.log('[browser] disconnected'));
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('crash', () => console.log('[page] CRASH at', new Date().toISOString()));
  page.on('close', () => console.log('[page] closed'));
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warning' || /\[gl\]|\[fleet|\[lines|\[zones/.test(t)) console.log(`[${m.type()}]`, t.slice(0, 220)); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 220)));
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(4000);
    try {
      const s = await page.evaluate(() => ({ cars: window.__layers?.vehicleLayer?.totalCount, segs: window.__layers?.roadLayer?.segments, fps: document.getElementById('p-fps')?.textContent }));
      console.log(`t+${(i + 1) * 4}s`, JSON.stringify(s));
    } catch (e) { console.log('eval failed:', e.message.slice(0, 80)); break; }
  }
  await browser.close().catch(() => {});
})();
