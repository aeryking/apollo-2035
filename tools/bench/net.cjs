// 抓取页面所有失败请求与地图瓦片请求
const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const fails = [], tiles = {};
  page.on('response', (r) => {
    const u = r.url();
    const host = new URL(u).host;
    if (/map\.baidu|bdimg|bdstatic/.test(host)) {
      const k = host + ' ' + new URL(u).pathname.split('/').slice(0, 3).join('/');
      tiles[k] = tiles[k] || { n: 0, status: {} };
      tiles[k].n++;
      tiles[k].status[r.status()] = (tiles[k].status[r.status()] || 0) + 1;
    }
    if (r.status() >= 400) fails.push(r.status() + ' ' + u.slice(0, 160));
  });
  page.on('requestfailed', (r) => fails.push('FAILED ' + r.failure()?.errorText + ' ' + r.url().slice(0, 160)));
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(Number(process.argv[3] || 15000));
  console.log('--- 百度相关请求 ---');
  for (const [k, v] of Object.entries(tiles)) console.log(String(v.n).padStart(4), JSON.stringify(v.status), k);
  console.log('--- 失败请求 ---');
  console.log([...new Set(fails)].slice(0, 25).join('\n') || '(无)');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await browser.close();
})();
