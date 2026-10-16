/**
 * WASM 与 JS 仿真内核对比：同一份北京真实路网、同样的车辆数与步数。
 * 两边算法逐行等价（推进 + 二分定位线段 + 插值 + 打包 16B 快照）。
 */
import fs from 'node:fs';
import { BASE_MC } from '../../src/core/projection.js';

const N = Number(process.argv[2] || 500_000);
const STEPS = Number(process.argv[3] || 20);

// 读北京路线池
const raw = fs.readFileSync('data-build.noindex/city-beijing.bin');
const flen = raw.readUInt32LE(33);
const payload = raw.buffer.slice(raw.byteOffset + 37, raw.byteOffset + 37 + flen);
const dv = new DataView(payload);
const R = dv.getUint32(0, true), V = dv.getUint32(4, true), S = dv.getUint32(8, true);
const cx = dv.getFloat64(16, true), cy = dv.getFloat64(24, true);
let o = 32;
const starts = new Uint32Array(payload, o, R + 1); o += 4 * (R + 1);
const dists = new Float32Array(payload, o, R); o += 4 * R;
const segOff = new Uint32Array(payload, o, R + 1); o += 4 * (R + 1);
const cum = new Float32Array(payload, o, S); o += 4 * S;
const xs = new Int32Array(payload, o, V); o += 4 * V;
const ys = new Int32Array(payload, o, V);
console.log(`北京：${R} 路线，${V.toLocaleString()} 顶点；车辆 ${N.toLocaleString()}，${STEPS} 步`);

function initState(rand) {
  const st = {
    city: new Uint16Array(N), route: new Int32Array(N), pos: new Float32Array(N), dir: new Int8Array(N),
    speed: new Float32Array(N), status: new Uint8Array(N), timer: new Float32Array(N), target: new Float32Array(N),
    born: new Uint8Array(N), len: new Uint8Array(N),
  };
  for (let i = 0; i < N; i++) {
    const r = (rand() * R) | 0;
    st.route[i] = r; st.pos[i] = rand() * dists[r]; st.dir[i] = rand() > 0.5 ? 1 : -1;
    st.speed[i] = 6 + rand() * 10; st.target[i] = st.speed[i]; st.timer[i] = 20 + rand() * 300;
    st.status[i] = 2; st.len[i] = 3;
  }
  return st;
}
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

/* -------------------------- JS 版（与 Worker 一致） -------------------------- */
const ox = cx - BASE_MC[0], oy = cy - BASE_MC[1];
function jsStep(st, dt, con) {
  for (let i = 0; i < N; i++) {
    st.timer[i] -= dt;
    if (st.timer[i] <= 0) {
      const u = Math.random();
      const s = u < 0.46 ? 2 : u < 0.78 ? 0 : u < 0.95 ? 1 : 3;
      st.status[i] = s; st.timer[i] = 30 + Math.random() * 300;
      st.target[i] = (5 + Math.random() * 12) * (s === 3 ? 0 : s === 2 ? 1 : 0.45);
    }
    st.speed[i] += (st.target[i] - st.speed[i]) * Math.min(1, dt * 0.7);
    const v = st.speed[i] * con;
    if (v <= 0.02) continue;
    const ri = st.route[i];
    const len = dists[ri] || 1;
    let pos = st.pos[i] + st.dir[i] * v * 1.25 * dt;
    if (pos > len) { pos = len - (pos - len); st.dir[i] = -1; } else if (pos < 0) { pos = -pos; st.dir[i] = 1; }
    st.pos[i] = pos;
  }
}
function jsSnap(st, out) {
  const f32 = new Float32Array(out), u8 = new Uint8Array(out);
  for (let i = 0; i < N; i++) {
    const ri = st.route[i];
    const lo = segOff[ri], hi = segOff[ri + 1];
    const pos = st.pos[i];
    let a = lo, b = hi;
    while (a < b) { const m = (a + b) >> 1; if (cum[m] < pos) a = m + 1; else b = m; }
    const k = Math.min(a, hi - 1);
    const s0 = k > lo ? cum[k - 1] : 0;
    const sl = Math.max(0.001, cum[k] - s0);
    const vi = starts[ri] + (k - lo);
    const ax = xs[vi], ay = ys[vi], bx = xs[vi + 1], by = ys[vi + 1];
    const f = Math.max(0, Math.min(1, (pos - s0) / sl));
    f32[i * 4] = ox + (ax + (bx - ax) * f) / 10;
    f32[i * 4 + 1] = oy + (ay + (by - ay) * f) / 10;
    f32[i * 4 + 2] = Math.atan2(by - ay, bx - ax);
    u8[i * 16 + 12] = Math.min(255, st.speed[i] * 3.6);
    u8[i * 16 + 13] = st.status[i]; u8[i * 16 + 14] = st.born[i]; u8[i * 16 + 15] = st.len[i];
    st.born[i] = 0;
  }
}

/* -------------------------- WASM 版 -------------------------- */
const { instance } = await WebAssembly.instantiate(fs.readFileSync('public/wasm/a35sim.wasm'));
const X = instance.exports;
const mem = () => X.memory.buffer;
const put = (ta) => { const p = X.alloc(ta.byteLength); new Uint8Array(mem(), p, ta.byteLength).set(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength)); return p; };
const cityP = { starts: put(starts), dists: put(dists), segOff: put(segOff), cum: put(cum), xs: put(xs), ys: put(ys) };
const cityStruct = X.alloc(40);
{
  const d = new DataView(mem(), cityStruct, 40);
  d.setUint32(0, cityP.starts, true); d.setUint32(4, cityP.dists, true); d.setUint32(8, cityP.segOff, true);
  d.setUint32(12, cityP.cum, true); d.setUint32(16, cityP.xs, true); d.setUint32(20, cityP.ys, true);
  d.setFloat64(24, ox, true); d.setFloat64(32, oy, true);
}
seed = 1;
const ws = initState(rand);
const wp = {}; for (const k of Object.keys(ws)) wp[k] = put(ws[k]);
const outP = X.alloc(N * 16);

/* -------------------------- 对比 -------------------------- */
seed = 1;
const js = initState(rand);
const jsOut = new ArrayBuffer(N * 16);

const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
// 预热
for (let i = 0; i < 3; i++) { jsStep(js, 1, 1); jsSnap(js, jsOut); X.step(N, cityStruct, wp.city, wp.route, wp.pos, wp.dir, wp.speed, wp.status, wp.timer, wp.target, 1, 1); X.snapshot(N, cityStruct, wp.city, wp.route, wp.pos, wp.speed, wp.status, wp.born, wp.len, outP); }

let tJsStep = 0, tJsSnap = 0, tWStep = 0, tWSnap = 0;
for (let s = 0; s < STEPS; s++) {
  tJsStep += time(() => jsStep(js, 1, 0.8));
  tJsSnap += time(() => jsSnap(js, jsOut));
  tWStep += time(() => X.step(N, cityStruct, wp.city, wp.route, wp.pos, wp.dir, wp.speed, wp.status, wp.timer, wp.target, 1, 0.8));
  tWSnap += time(() => X.snapshot(N, cityStruct, wp.city, wp.route, wp.pos, wp.speed, wp.status, wp.born, wp.len, outP));
}
const per = (t) => (t / STEPS).toFixed(2);
console.log(`              推进(ms/步)  快照(ms/步)  合计     每百万车合计`);
console.log(`JS          ${per(tJsStep).padStart(9)}  ${per(tJsSnap).padStart(10)}  ${per(tJsStep + tJsSnap).padStart(6)}   ${((tJsStep + tJsSnap) / STEPS / N * 1e6).toFixed(1)} ms`);
console.log(`WASM        ${per(tWStep).padStart(9)}  ${per(tWSnap).padStart(10)}  ${per(tWStep + tWSnap).padStart(6)}   ${((tWStep + tWSnap) / STEPS / N * 1e6).toFixed(1)} ms`);
console.log(`加速比：推进 ${(tJsStep / tWStep).toFixed(2)}×，快照 ${(tJsSnap / tWSnap).toFixed(2)}×，合计 ${((tJsStep + tJsSnap) / (tWStep + tWSnap)).toFixed(2)}×`);

// 正确性：对第 0 步之前同状态做一致性检查（位置插值部分）
const wOut = new Float32Array(mem(), outP, N * 4);
const jOut = new Float32Array(jsOut);
let maxErr = 0;
for (let i = 0; i < Math.min(N, 20000); i++) {
  // 随机状态切换不同，比较只针对插值函数：用 WASM 的 pos 跑一遍 JS 插值
}
console.log('（状态机用不同随机源，逐车位置不可直接比较；插值正确性见下方单独校验）');

// 插值一致性：同一组 pos，两边各算一次
const pos = new Float32Array(mem(), wp.pos, N);
for (let i = 0; i < N; i++) js.pos[i] = pos[i];
jsSnap(js, jsOut);
X.snapshot(N, cityStruct, wp.city, wp.route, wp.pos, wp.speed, wp.status, wp.born, wp.len, outP);
const w2 = new Float32Array(mem(), outP, N * 4);
for (let i = 0; i < N; i++) {
  const e = Math.hypot(w2[i * 4] - jOut[i * 4], w2[i * 4 + 1] - jOut[i * 4 + 1]);
  if (e > maxErr) maxErr = e;
}
let maxAng = 0;
for (let i = 0; i < N; i++) {
  let d = Math.abs(w2[i * 4 + 2] - jOut[i * 4 + 2]);
  if (d > Math.PI) d = 2 * Math.PI - d;
  if (d > maxAng) maxAng = d;
}
console.log(`插值一致性：位置最大差 ${maxErr.toFixed(3)} MC 单位，朝向最大差 ${maxAng.toFixed(4)} rad`);
