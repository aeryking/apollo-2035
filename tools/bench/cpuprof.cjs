// 采集主线程 CPU Profile，按自身耗时排序输出热点函数
const { chromium } = require(process.env.PWC || 'playwright-core');
const { launch } = require('./real.cjs');
(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(Number(process.argv[3] || 4000));
  await cdp.send('Profiler.start');
  await page.waitForTimeout(Number(process.argv[4] || 16000));
  const { profile } = await cdp.send('Profiler.stop');
  // 计算 self time
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const k = `${n.callFrame.functionName || '(anon)'} @ ${(n.callFrame.url || '').split('/').slice(-2).join('/')}:${n.callFrame.lineNumber + 1}`;
    self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  console.log(`采样总时长 ${(total / 1000).toFixed(2)}s`);
  [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22).forEach(([k, v]) => console.log(`${v.toFixed(0).padStart(7)} ms  ${(100 * v / total).toFixed(1).padStart(5)}%  ${k.slice(0, 140)}`));
  // 打印热点函数的调用链（父节点）
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const nameOf = (n) => `${n.callFrame.functionName || '(anon)'}@${(n.callFrame.url || '').split('/').pop().slice(0, 30)}:${n.callFrame.lineNumber + 1}`;
  const targets = (process.env.CHAIN || '').split(',').filter(Boolean);
  for (const t of targets) {
    const agg = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
      let n = byId.get(profile.samples[i]);
      if ((n.callFrame.functionName || '') !== t) continue;
      const chain = [];
      let cur = n;
      for (let d = 0; d < 9 && cur; d++) { chain.push(nameOf(cur)); cur = byId.get(parent.get(cur.id)); }
      const k = chain.join(' <- ');
      agg.set(k, (agg.get(k) || 0) + (dt[i] || 0) / 1000);
    }
    console.log(`\n=== 调用链: ${t} ===`);
    [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).forEach(([k, v]) => console.log(`${v.toFixed(0).padStart(6)}ms  ${k}`));
  }
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
