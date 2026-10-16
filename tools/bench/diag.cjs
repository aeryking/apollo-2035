// 主线程诊断：长任务、图层耗时、消息吞吐
const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    window.__lt = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration), e.attribution?.[0]?.containerSrc || e.attribution?.[0]?.name || '']); }).observe({ type: 'longtask', buffered: true });
    // 统计 Worker 消息到达次数与体积
    window.__wm = { n: 0, bytes: 0 };
    const W = window.Worker;
    window.Worker = function (u, o) {
      const w = new W(u, o);
      w.addEventListener('message', (e) => { window.__wm.n++; const d = e.data && e.data.data; if (d && d.byteLength) window.__wm.bytes += d.byteLength; });
      return w;
    };
    window.Worker.prototype = W.prototype;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(5000);
    const m = await cdp.send('Performance.getMetrics');
    const g = (k) => m.metrics.find((x) => x.name === k)?.value;
    const s = await page.evaluate(() => {
      const L = window.__layers || {};
      const v = L.vehicleLayer;
      const lt = window.__lt.splice(0);
      return {
        cars: v?.totalCount, drawMs: v?.stats.drawMs?.toFixed(2), upMs: v?.stats.uploadMs?.toFixed(2),
        maxCall: v?.stats.maxCallMs?.toFixed(1), alloc: v?.stats.allocMs?.toFixed(1),
        longTasks: lt.length, ltMax: lt.reduce((a, b) => Math.max(a, b[1]), 0), ltSum: lt.reduce((a, b) => a + b[1], 0),
        msgs: window.__wm.n, msgMB: (window.__wm.bytes / 1048576).toFixed(1),
      };
    });
    console.log(`t+${(i + 1) * 5}s`, JSON.stringify(s), `TaskDur=${g('TaskDuration')?.toFixed(1)}s Script=${g('ScriptDuration')?.toFixed(1)}s Heap=${(g('JSHeapUsedSize') / 1048576).toFixed(0)}MB`);
  }
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
