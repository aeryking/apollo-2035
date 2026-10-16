const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: !process.env.HEADED });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('response', async (r) => {
    const u = r.url();
    if (/pvd|qt=vtile|qt=tile|\/tile\//.test(u)) {
      let len = -1, head = '';
      try { const b = await r.body(); len = b.length; head = b.subarray(0, 80).toString('latin1').replace(/[^\x20-\x7e]/g, '.'); } catch (e) { head = 'ERR ' + e.message; }
      console.log(r.status(), len, 'B', u.replace(/ak=[^&]+/, 'ak=***').slice(0, 150), '\n    ', head);
    }
  });
  page.on('console', (m) => { if (m.type() !== 'debug') console.log('[console]', m.type(), m.text().slice(0, 200)); });
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(Number(process.argv[3] || 12000));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await browser.close();
})();
