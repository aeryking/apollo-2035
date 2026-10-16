/**
 * 渲染规模压力测试：?stress=N，等全部上传完后静止采样 6 秒。
 * GPU 耗时来自 EXT_disjoint_timer_query（与主线程负载无关，最能反映渲染能力）。
 */
const { chromium } = require(process.env.PWC || 'playwright-core');
const { launch } = require('./real.cjs');
const sizes = (process.argv[2] || '1000000,2000000,4000000').split(',').map(Number);
const zoom = process.argv[3] || '5';
(async () => {
  for (const n of sizes) {
    const browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    try {
      await page.goto(`http://localhost:5173/?stress=${n}&roads=0&zones=0&zoom=${zoom}${process.env.EXTRA || ""}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction((n) => (window.__layers?.vehicleLayer?.totalCount || 0) >= n, n, { timeout: 180000, polling: 1000 });
      const r = await page.evaluate(() => new Promise((res) => {
        const L = window.__layers.vehicleLayer;
        const gpu = [], frames = [];
        let prev = performance.now(); const t0 = prev;
        const loop = () => {
          const now = performance.now(); frames.push(now - prev); prev = now;
          if (L.stats.gpuMs != null) gpu.push(L.stats.gpuMs);
          if (now - t0 > 6000) {
            const sorted = [...frames].sort((a, b) => a - b);
            const g = gpu.filter((x) => x > 0);
            return res({
              avgFps: +(1000 / (frames.reduce((a, b) => a + b, 0) / frames.length)).toFixed(1),
              p50FrameMs: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
              gpuMs: g.length ? +(g.reduce((a, b) => a + b, 0) / g.length).toFixed(2) : null,
              gpuMsMax: g.length ? +Math.max(...g).toFixed(2) : null,
              draws: L.stats.draws, vramMB: +(L.vramBytes / 1048576).toFixed(0),
              heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null,
              genMs: Math.round(window.__state.stressGenMs || 0),
            });
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }));
      console.log(`N=${n.toLocaleString().padStart(10)} zoom=${zoom}`, JSON.stringify(r));
    } catch (e) {
      console.log(`N=${n.toLocaleString().padStart(10)} 失败: ${e.message.slice(0, 120)}`);
    }
    await browser.close().catch(() => {});
  }
})();
