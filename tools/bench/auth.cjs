const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.on('response', async (r) => {
    const u = r.url();
    if (/api\.map\.baidu\.com\/(\?|$|verify|sdkproxy|lbsapi)|pvd|error/.test(u) || /api\.map\.baidu\.com\/[^/]*\?qt=/.test(u)) {
      let body = '';
      try { body = (await r.text()).slice(0, 200); } catch {}
      console.log(r.status(), u.replace(/ak=[^&]+/, 'ak=***').slice(0, 170), '\n   →', body.replace(/\s+/g, ' '));
    }
  });
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000);
  await browser.close();
})();
