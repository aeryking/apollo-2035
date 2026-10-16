/** 快速帧率采样：打开页面 → 等 warm 秒 → 采样 secs 秒的 rAF 帧间隔 */
const { launch } = require('./real.cjs');
(async () => {
  const [url, warm = '20', secs = '8'] = process.argv.slice(2);
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(Number(warm) * 1000);
  const r = await page.evaluate((ms) => new Promise((res) => {
    const f = []; let prev = performance.now(); const t0 = prev;
    const loop = () => {
      const now = performance.now(); f.push(now - prev); prev = now;
      if (now - t0 > ms) {
        const s = [...f].sort((a, b) => a - b);
        const L = window.__layers || {};
        res({ fps: +(1000 / (f.reduce((a, b) => a + b, 0) / f.length)).toFixed(1), p50: +s[s.length >> 1].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s[s.length - 1].toFixed(0), frames: f.length, cars: L.vehicleLayer?.totalCount, segs: L.roadLayer?.segments, gpu: L.vehicleLayer?.stats.gpuMs });
      } else requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }), Number(secs) * 1000);
  console.log(JSON.stringify(r));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
