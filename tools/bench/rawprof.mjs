/**
 * 「最小侵入」CPU 采样：普通 Chrome + 远程调试端口，只启用 Profiler / Page 两个域，
 * 不启用 Runtime（百度反爬会利用 Runtime 的副作用识别调试环境）。
 * 用法：node tools/bench/rawprof.mjs <url> <采样秒数> [延迟秒数]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [url, secs = '6', delay = '0'] = process.argv.slice(2);
const PORT = 9333;
// 每次用全新的配置目录：上一个实例若未完全退出，复用同一目录会让新进程把请求转交旧实例后直接退出
const PROFILE = `/tmp/a35chrome-prof-${Date.now()}`;
fs.mkdirSync(PROFILE, { recursive: true });
try { fs.rmSync(`${PROFILE}/DevToolsActivePort`); } catch {}
const chrome = spawn('/bin/zsh', ['-c', `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=${PROFILE} --remote-debugging-port=${PORT} --no-first-run --no-default-browser-check --window-size=1600,900 --window-position=40,40 about:blank > /tmp/a35probe/chrome-prof.log 2>&1`], { stdio: 'ignore', detached: true });
const killChrome = () => {
  try { process.kill(-chrome.pid); } catch {}
  spawn('/usr/bin/pkill', ['-f', `user-data-dir=${PROFILE}`]);
  setTimeout(() => { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} }, 1500);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch {}
}
if (!target) { console.error('未连上 Chrome'); killChrome(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 500 });
await send('Page.navigate', { url });
await sleep(Number(delay) * 1000);
await send('Profiler.start');
await sleep(Number(secs) * 1000);
const { profile } = await send('Profiler.stop');

// 自身耗时 + 归属（按脚本来源汇总）
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map(), bySrc = new Map();
profile.samples.forEach((sid, i) => {
  const n = byId.get(sid);
  const dt = (profile.timeDeltas[i] || 0) / 1000;
  const u = n.callFrame.url || '';
  const src = /api\.map\.baidu|bdimg|abclite|getscript|^$/.test(u) && !/localhost/.test(u)
    ? (u ? 'baidu' : (n.callFrame.functionName.startsWith('(') ? n.callFrame.functionName : 'native/匿名'))
    : (/localhost/.test(u) ? 'ours:' + u.split('/').slice(-2).join('/').split('?')[0] : 'other');
  bySrc.set(src, (bySrc.get(src) || 0) + dt);
  const k = `${n.callFrame.functionName || '(anon)'} @ ${u.split('/').slice(-2).join('/').split('?')[0]}:${n.callFrame.lineNumber + 1}`;
  self.set(k, (self.get(k) || 0) + dt);
});
const total = [...self.values()].reduce((a, b) => a + b, 0);
const idle = (self.get('(idle) @ :0') || 0);
console.log(`采样 ${(total / 1000).toFixed(2)} s，空闲 ${(100 * idle / total).toFixed(1)}%`);
console.log('— 按来源 —');
[...bySrc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).forEach(([k, v]) => console.log(`${v.toFixed(0).padStart(7)} ms ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`));
console.log('— 热点函数（不含空闲）—');
[...self.entries()].filter(([k]) => !k.startsWith('(idle)')).sort((a, b) => b[1] - a[1]).slice(0, 16).forEach(([k, v]) => console.log(`${v.toFixed(0).padStart(7)} ms ${(100 * v / total).toFixed(1).padStart(5)}%  ${k.slice(0, 120)}`));
ws.close();
killChrome();
await sleep(500);
process.exit(0);
