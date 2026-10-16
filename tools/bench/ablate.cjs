// 逐图层开合，定位各层对帧率的实际影响
const { chromium } = require(process.env.PWC || 'playwright-core');
const { launch } = require('./real.cjs');
const cases = [
  { name: '空地图', q: 'start=0&zones=0&roads=0' },
  { name: '仅面',   q: 'start=0&zones=1&roads=0' },
  { name: '仅线',   q: 'start=0&zones=0&roads=1' },
  { name: '+线+面', q: 'start=0&zones=1&roads=1' },
  { name: '全开300k车', q: 'fleet=300000&zones=1&roads=1' },
  { name: '全开600k车', q: 'fleet=600000&zones=1&roads=1' },
];
(async () => {
  const browser = await launch();
  for (const c of cases) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://localhost:5173/?' + c.q, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(32000);   // 让数据基本加载完
    // 采样 5 秒
    const r = await page.evaluate(() => new Promise((res) => {
      let n = 0, sum = 0, max = 0, last = performance.now(), prev = last;
      const loop = () => {
        const now = performance.now();
        const dt = now - prev; prev = now;
        if (n > 30) { const fps = 1000 / dt; sum += fps; max = Math.max(max, dt); }
        if (n > 30 && now - last > 5000) {
          const L = window.__layers || {};
          return res({
            frames: n - 30, avgFps: +(sum / (n - 30)).toFixed(1), maxFrameMs: +max.toFixed(1),
            dc: (L.zoneLayer?.stats.draws || 0) + (L.roadLayer?.stats.draws || 0) + (L.vehicleLayer?.stats.draws || 0),
            roadSegs: L.roadLayer?.segments, zoneTris: L.zoneLayer?.fillCount, cars: L.vehicleLayer?.totalCount,
          });
        }
        n++;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }));
    console.log(c.name.padEnd(12), JSON.stringify(r));
    await page.close();
  }
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
