// 版面检查：各悬浮面板之间是否互相遮挡（只看 DOM 布局，与地图渲染无关）
const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const [w, h] of [[1470, 755], [1440, 900], [1280, 720], [1920, 1080]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto('http://localhost:5173/?start=0&roads=0&zones=0', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
      const ids = ['hud-head', 'hud-metrics', 'hud-perf', 'hud-layers', 'hud-scene'];
      const box = Object.fromEntries(ids.map((id) => { const b = document.getElementById(id).getBoundingClientRect(); return [id, [b.left, b.top, b.right, b.bottom].map(Math.round)]; }));
      const hits = [];
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const a = box[ids[i]], b = box[ids[j]];
        if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) hits.push(`${ids[i]}×${ids[j]}`);
      }
      return { hits, perf: box['hud-perf'], scene: box['hud-scene'] };
    });
    console.log(`${w}×${h}`, r.hits.length ? '重叠: ' + r.hits.join(', ') : '无重叠', ' perf', JSON.stringify(r.perf), ' scene', JSON.stringify(r.scene));
    await page.close();
  }
  await browser.close();
})();
