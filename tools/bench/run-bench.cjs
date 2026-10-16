/**
 * 自动跑内置性能测试，把结果写到 docs/bench/ 下。
 * 用法：node tools/bench/run-bench.cjs <fleet> [extraQuery]
 * HEADED=1 用有头浏览器（真实合成路径，更接近用户环境）
 */
const { chromium } = require(process.env.PWC || 'playwright-core');
const { launch } = require('./real.cjs');
const fs = require('fs');
const path = require('path');
const fleet = Number(process.argv[2] || 300000);
const extra = process.argv[3] || '';
(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: Number(process.env.DPR || 1) });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  const url = `http://localhost:5173/?bench=1&fleet=${fleet}${extra ? '&' + extra : ''}`;
  console.log('打开', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__benchResult, null, { timeout: 240000, polling: 2000 });
  const r = await page.evaluate(() => window.__benchResult);
  const md = await page.evaluate(() => window.__benchMd);
  const dir = path.resolve('docs/bench');
  fs.mkdirSync(dir, { recursive: true });
  const tag = `${process.env.HEADED ? 'headed' : 'headless'}-${fleet}${extra ? '-' + extra.replace(/[^a-z0-9]+/gi, '_') : ''}`;
  fs.writeFileSync(path.join(dir, `${tag}.json`), JSON.stringify(r, null, 2));
  fs.writeFileSync(path.join(dir, `${tag}.md`), md);
  console.log(md);
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
