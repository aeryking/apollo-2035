// 包装 Worker，观察百度瓦片解码 Worker 的往返消息
const { chromium } = require(process.env.PWC || 'playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    window.__wlog = [];
    const W = window.Worker;
    window.Worker = function (url, opts) {
      const w = new W(url, opts);
      const id = window.__wlog.length;
      const rec = { id, url: String(url).slice(0, 60), sent: 0, recv: 0, errors: [], sentTypes: {}, recvTypes: {}, sample: null };
      window.__wlog.push(rec);
      const post = w.postMessage.bind(w);
      w.postMessage = (m, t) => {
        rec.sent++;
        const k = m && typeof m === 'object' ? (m.action || m.type || m.cmd || Object.keys(m).slice(0, 3).join(',')) : typeof m;
        rec.sentTypes[k] = (rec.sentTypes[k] || 0) + 1;
        return post(m, t);
      };
      w.addEventListener('message', (e) => {
        rec.recv++;
        const m = e.data;
        const k = m && typeof m === 'object' ? (m.action || m.type || m.cmd || Object.keys(m).slice(0, 4).join(',')) : typeof m;
        rec.recvTypes[k] = (rec.recvTypes[k] || 0) + 1;
        if (!rec.sample && m && typeof m === 'object') rec.sample = JSON.stringify(m, (kk, v) => (v && v.byteLength ? `<${v.constructor.name} ${v.byteLength}>` : v)).slice(0, 300);
      });
      w.addEventListener('error', (e) => rec.errors.push(e.message));
      return w;
    };
    window.Worker.prototype = W.prototype;
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000);
  console.log(JSON.stringify(await page.evaluate(() => window.__wlog), null, 1));
  await browser.close();
})();
