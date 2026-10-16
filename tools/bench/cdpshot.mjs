/**
 * 通过 DevTools 协议给「已经在跑」的 Chrome 页面截图（真实时钟，不用 --virtual-time-budget）。
 * 只发 Page.captureScreenshot（以及可选的一条 Runtime.evaluate）—— 不开 Runtime 等调试域，尽量不惊动页面。
 * 用法：node tools/bench/cdpshot.mjs <webSocketDebuggerUrl> <输出png|-> [JS 表达式]
 *       输出写 - 表示不截图，只求值
 */
import { writeFileSync } from 'node:fs';

const [wsUrl, out, expr] = process.argv.slice(2);
const ws = new WebSocket(wsUrl);
let id = 0;
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== mid) return;
    ws.removeEventListener('message', onMsg);
    m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id: mid, method, params }));
});

ws.addEventListener('open', async () => {
  try {
    if (expr) {
      const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      console.log(JSON.stringify(r.result.value ?? r.result.description ?? null, null, 1));
    }
    if (out && out !== '-') {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log('OK', out);
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  ws.close();
});
ws.addEventListener('error', (e) => { console.error('WS 错误', e.message || e); process.exitCode = 1; });
