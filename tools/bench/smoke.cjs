/**
 * 冒烟测试：真实浏览器里跑起来，抓控制台错误、统计数字与截图。
 * 用法：PWC=<playwright-core> node tools/bench/smoke.cjs [url] [seconds]
 */
const { chromium } = require(process.env.PWC || 'playwright-core');
const { launch } = require('./real.cjs');
const url = process.argv[2] || 'http://localhost:5173/?fleet=200000';
const seconds = Number(process.argv[3] || 25);
const shot = process.env.SHOT;

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/Failed to load resource.*favicon/.test(t)) return;
    if (m.type() === 'error') { errors.push(t); console.log('[console.error]', t.slice(0, 300)); }
    else if (/\[data\]|\[fleet|\[BMap\]|\[gl\]/.test(t)) console.log('[log]', t.slice(0, 260));
  });
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const t0 = Date.now();
  const samples = [];
  while ((Date.now() - t0) / 1000 < seconds) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => {
      const L = window.__layer;
      return {
        t: Math.round(performance.now()),
        fps: +(document.getElementById('p-fps')?.textContent || 0),
        cars: +(document.getElementById('m-cars')?.textContent.replace(/[^0-9]/g, '') || 0),
        feats: +(document.getElementById('m-features')?.textContent.replace(/[^0-9]/g, '') || 0),
        mb: document.getElementById('m-bytes')?.textContent,
        rate: document.getElementById('m-rate')?.textContent,
        dc: document.getElementById('p-dc')?.textContent,
        up: document.getElementById('p-upload')?.textContent,
        gpu: document.getElementById('p-gpu')?.textContent,
        layerFilled: L ? L.parts.map((p) => p.filled) : null,
        visible: L ? L.visibleCount : null,
        total: L ? L.totalCount : null,
        zoom: window.__map ? +window.__map.getZoom().toFixed(2) : null,
      };
    });
    samples.push(s);
    process.stdout.write(`  t=${String(s.t).padStart(6)} fps=${String(s.fps).padStart(3)} 车=${s.cars} 可见=${s.feats} 上传=${s.up} GPU=${s.gpu} DC=${s.dc} zoom=${s.zoom}\n`);
  }
  const fpsList = samples.slice(3).map((s) => s.fps).filter((v) => v > 0);
  const avg = fpsList.reduce((a, b) => a + b, 0) / Math.max(1, fpsList.length);
  const min = fpsList.length ? Math.min(...fpsList) : 0;
  console.log(`\n平均 FPS ${avg.toFixed(1)}，最低 ${min}，错误 ${errors.length} 条`);
  if (errors.length) console.log(errors.slice(0, 6).join('\n'));
  if (shot) await page.screenshot({ path: shot, timeout: 20000 }).catch((e) => console.log('screenshot failed', e.message));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
