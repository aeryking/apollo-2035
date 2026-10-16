const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.on('request', (r) => { const u = r.url(); if (/pvd|bdimg\.com\/(tile|onlinelabel)|qt=vtile/.test(u)) console.log(u); });
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);
  await browser.close();
})();
