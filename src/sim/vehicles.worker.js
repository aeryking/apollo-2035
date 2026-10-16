/**
 * 车辆仿真 Worker —— 后台线程推进全国车流。
 *
 * 分工：本线程只做「位置计算 + 打包快照」，主线程只做「上传显存 + 绘制」。
 * 车辆数增加时，主线程开销几乎不变（只多几次 bufferSubData），
 * 这是保证「数据持续加载时地图交互仍然流畅」的关键。
 *
 * 快照格式：每车 16 字节
 *   float32 x, y   图层坐标（BD09MC - BASE_MC），float32 在全国范围精度约 0.25 m
 *   float32 angle  朝向（弧度）
 *   uint8   speed  速度 km/h
 *   uint8   state  0 空驶 1 接驾 2 载客 3 充电 4 让行
 *   uint8   born   1 = 本秒新出现（GPU 不插值，避免从原点飞入）
 *   uint8   len    车身长度（米 / 2，0 表示空槽）
 */

import { BASE_MC } from '../core/projection.js';
import { FrameParser, FRAME } from '../stream/binary.js';

const ST = { IDLE: 0, PICKUP: 1, TRIP: 2, CHARGE: 3, RESCUE: 4 };
const SNAP_STRIDE = 16;

/* ------------------------- WASM 内核（默认开启，失败自动降级 JS） ------------------------- */
let W = null;               // WASM exports
let wasmOn = false;
let P = null;               // 状态数组在 WASM 内存中的指针
let citiesPtr = 0;          // City 结构体数组指针（每个 40 B）
const CITY_STRUCT = 40;
const MAX_CITIES = 1024;

async function initWasm(url) {
  try {
    const res = await fetch(url);
    const { instance } = await WebAssembly.instantiate(await res.arrayBuffer());
    W = instance.exports;
    W.seed((Math.random() * 0xffffffff) >>> 0);
    return true;
  } catch (e) {
    self.postMessage({ t: 'warn', msg: 'WASM 不可用，回退 JS：' + e.message });
    return false;
  }
}

/** 把 TypedArray 拷进 WASM 内存，返回指针 */
function wput(ta) {
  const p = W.alloc(ta.byteLength);
  new Uint8Array(W.memory.buffer, p, ta.byteLength).set(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength));
  return p;
}

/**
 * WASM 内存增长后旧视图会失效（ArrayBuffer 被分离），每次分配后重建视图。
 * 车辆状态数组本身就住在 WASM 内存里，JS 与 WASM 共享同一份数据，零拷贝。
 */
function bindViews() {
  const b = W.memory.buffer;
  sCity = new Uint16Array(b, P.city, n);
  sRoute = new Int32Array(b, P.route, n);
  sPos = new Float32Array(b, P.pos, n);
  sDir = new Int8Array(b, P.dir, n);
  sSpeed = new Float32Array(b, P.speed, n);
  sStatus = new Uint8Array(b, P.status, n);
  sTimer = new Float32Array(b, P.timer, n);
  sTarget = new Float32Array(b, P.target, n);
  sLen = new Uint8Array(b, P.len, n);
  sBorn = new Uint8Array(b, P.born, n);
}

let cfg = null;
let n = 0;                    // 本 Worker 负责的车辆总数
let simMs = 0;
let timeScale = 1;
let tod = 450;                // 一天中的分钟数
let tide = 0;                 // 1 早高峰(朝心) -1 晚高峰(离心) 0 平峰
let tideManual = false;

/* ------------------------- 生命通道（救护车让行） ------------------------- */
// corridor = { ci, ri, s, len, pts:[x,y...图层坐标], cum:[...] }
let corridor = null;
let pendingCorridor = null;   // 已请求、但该城数据尚未到齐的生命通道
let corridorKind = 'ambulance';
const YIELD_AHEAD = 1600 * 1.3;   // 救护车前方 1.6 km 开始让行（MC 单位）
const YIELD_WIDTH = 140;          // 路线两侧 ~110 m 内的车辆让行
const AMBULANCE_MS = 19;          // 救护车速度 ≈ 68 km/h
// 事件种类：120 救护车（单车）/ 119 消防车队（警车开道 + 4 辆消防车）
const EVENT_KINDS = {
  ambulance: { speed: AMBULANCE_MS, units: 1, ahead: YIELD_AHEAD, width: YIELD_WIDTH },
  fire: { speed: 15, units: 5, ahead: 2200 * 1.3, width: 175 },   // ≈ 54 km/h；警车开道，前方 2.2 km 提前清道
};
const CONVOY_GAP = 180 * 1.25;     // 车距（MC 单位）：比真实车距大 —— 图标按屏幕像素定大小，15.6 级下要这么远才不首尾相连
let running = false;
let activeCount = 0;          // 已生成车辆数

/* 车辆状态（SoA） */
let sCity, sRoute, sPos, sDir, sSpeed, sStatus, sTimer, sTarget, sLen, sBorn;

/* 城市索引表：城市数据流式到达，逐个启用 */
const cities = [];
let nextQuota = null;

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.cmd === 'config') {
    cfg = m;
    n = m.n;
    (async () => {
      wasmOn = m.wasm !== false && (await initWasm(m.wasmUrl));
      allocate();
      boot(m);
    })();
  } else if (m.cmd === 'noop') {
  } else if (m.cmd === 'sim') {
    if (typeof m.timeScale === 'number') timeScale = m.timeScale;
    if (typeof m.tod === 'number') tod = m.tod;
    if (typeof m.tide === 'number') { tide = m.tide; tideManual = m.tideManual === true; }
  } else if (m.cmd === 'corridor') {
    // 城市数据可能还在路上（直达链接 2.5 秒就切幕）：先记下，数据到齐后再开（见 loadCityPayload）
    pendingCorridor = m.on ? (m.cityId || 'beijing') : null;
    corridorKind = EVENT_KINDS[m.kind] ? m.kind : 'ambulance';
    if (m.on) startCorridor(pendingCorridor); else corridor = null;
  } else if (m.cmd === 'stop') {
    running = false;
  }
};

/** 启动：仿真循环立即开始，城市数据边下载边加入（真正的流式） */
function boot(m) {
  running = true;
  last = performance.now();
  // 各 Worker 的快照相位错开 1/N 秒：上传负载在一秒内均匀分布，而不是集中在同几帧
  const phase = ((m.workerIndex || 0) / Math.max(1, m.workerCount || 1)) * 1000;
  setTimeout(loop, phase);
  (async () => {
    // 按块流式读取：fetch 的 ReadableStream 每到一段字节就喂给帧解析器，
    // 解析出一个完整城市帧就立刻生成该城车辆 —— 不等整块下载完。
    for (const pack of m.packs) await streamPack(pack);
    self.postMessage({ t: 'ready', n, cities: cities.length, spawned: activeCount, bytes: bytesIn, wasm: wasmOn });
  })();
}

function allocate() {
  if (wasmOn) {
    // 状态数组与城市表都放进 WASM 线性内存
    P = {
      city: W.alloc(n * 2), route: W.alloc(n * 4), pos: W.alloc(n * 4), dir: W.alloc(n),
      speed: W.alloc(n * 4), status: W.alloc(n), timer: W.alloc(n * 4), target: W.alloc(n * 4),
      len: W.alloc(n), born: W.alloc(n), out: W.alloc(Math.max(16, n * SNAP_STRIDE)),
    };
    citiesPtr = W.alloc(MAX_CITIES * CITY_STRUCT);
    bindViews();
    return;
  }
  sCity = new Uint16Array(n);
  sRoute = new Int32Array(n);
  sPos = new Float32Array(n);
  sDir = new Int8Array(n);
  sSpeed = new Float32Array(n);
  sStatus = new Uint8Array(n);
  sTimer = new Float32Array(n);
  sTarget = new Float32Array(n);
  sLen = new Uint8Array(n);
  sBorn = new Uint8Array(n);
}

let bytesIn = 0;

/** 流式读取一个区域数据块：边下载边解析，每解析出一个城市立即上车 */
async function streamPack(pack) {
  const res = await fetch(cfg.baseUrl + pack.file);
  if (!res.ok) { self.postMessage({ t: 'warn', msg: `${pack.file} HTTP ${res.status}` }); return; }
  const reader = res.body.getReader();
  const parser = new FrameParser();
  let pendingId = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesIn += value.byteLength;
    self.postMessage({ t: 'bytes', n: value.byteLength });
    for (const f of parser.push(value)) {
      if (f.type === FRAME.META) pendingId = new TextDecoder().decode(f.payload);
      else if (f.type === FRAME.TRAJ_CHUNK && pendingId) {
        const [id, frac] = pendingId.split('|');
        if (!cfg.cityIds || cfg.cityIds.includes(id)) loadCityPayload(id, f.payload, Number(frac || 1));
        pendingId = null;
      }
    }
  }
}

/** 解析一个城市的路线池 payload，并立即生成该城车辆 */
const spawnedById = new Map();   // 每座城市已分配的车辆数（城市被拆成多帧时累计）
const fracById = new Map();      // 每座城市已到达的数据占比

function loadCityPayload(id, buf, fraction = 1) {
  const dv = new DataView(buf);
  const routeCount = dv.getUint32(0, true);
  const nVert = dv.getUint32(4, true);
  const nSeg = dv.getUint32(8, true);
  const real = dv.getUint32(12, true) > 0;
  const cx = dv.getFloat64(16, true);
  const cy = dv.getFloat64(24, true);

  let o = 32;
  const starts = new Uint32Array(buf, o, routeCount + 1); o += 4 * (routeCount + 1);
  const dists = new Float32Array(buf, o, routeCount); o += 4 * routeCount;
  const segOff = new Uint32Array(buf, o, routeCount + 1); o += 4 * (routeCount + 1);
  const cum = new Float32Array(buf, o, nSeg); o += 4 * nSeg;
  const xs = new Int32Array(buf, o, nVert); o += 4 * nVert;
  const ys = new Int32Array(buf, o, nVert); o += 4 * nVert;
  const meta = new Uint8Array(buf, o, nVert * 2);

  const city = {
    id, routeCount, starts, dists, segOff, cum, xs, ys, meta, cx, cy, real,
    ox: cx - BASE_MC[0], oy: cy - BASE_MC[1],
    start: activeCount, count: 0, bbox: cityBBox(xs, ys, cx - BASE_MC[0], cy - BASE_MC[1]),
  };
  if (wasmOn && cities.length < MAX_CITIES) {
    const ptr = { starts: wput(starts), dists: wput(dists), segOff: wput(segOff), cum: wput(cum), xs: wput(xs), ys: wput(ys) };
    bindViews();   // 分配可能触发内存增长，重建视图
    const d = new DataView(W.memory.buffer, citiesPtr + cities.length * CITY_STRUCT, CITY_STRUCT);
    d.setUint32(0, ptr.starts, true); d.setUint32(4, ptr.dists, true); d.setUint32(8, ptr.segOff, true);
    d.setUint32(12, ptr.cum, true); d.setUint32(16, ptr.xs, true); d.setUint32(20, ptr.ys, true);
    d.setFloat64(24, city.ox, true); d.setFloat64(32, city.oy, true);
  }
  cities.push(city);
  spawnFor(city, id, fraction);
  city.count = activeCount - city.start;
  self.postMessage({
    t: 'city', id, routes: routeCount, verts: nVert, real, spawned: activeCount,
    range: { start: city.start, count: city.count, bbox: city.bbox },
  });
  if (pendingCorridor === id && !corridor && (fracById.get(id) || 0) >= 0.9999) startCorridor(id);
}

/** 城市包围盒（图层坐标），供主线程做视锥剔除 */
function cityBBox(xs, ys, ox, oy) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < xs.length; i += 7) {
    const x = xs[i] / 10, y = ys[i] / 10;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [ox + x0, oy + y0, ox + x1, oy + y1];
}

/** 按城市权重分配车辆份额并生成 */
function spawnFor(city, id, fraction) {
  if (nextQuota === null) {
    // 首次：按权重把总车数分配到所有已声明的城市
    nextQuota = new Float32Array(cfg.cityIds.length);
    for (let i = 0; i < cfg.cityIds.length; i++) nextQuota[i] = 1;
  }
  const idx = cities.length - 1;
  const qi = cfg.cityIds.indexOf(id);
  const quota = cfg.quota ? cfg.quota[qi] : Math.round(n / Math.max(1, cfg.cityIds.length));
  // 按本帧占比分配；该城最后一帧（累计占比到 1）补齐余数，保证总数精确
  const done = (fracById.get(id) || 0) + fraction;
  fracById.set(id, done);
  const already = spawnedById.get(id) || 0;
  const share = done >= 0.9999 ? quota - already : Math.round(quota * fraction);
  const target = Math.max(0, Math.min(share, n - activeCount));
  spawnedById.set(id, already + target);
  const rnd = Math.random;
  for (let k = 0; k < target; k++) {
    const i = activeCount++;
    if (i >= n) break;
    sCity[i] = idx;
    const r = (rnd() * city.routeCount) | 0;
    sRoute[i] = r;
    sPos[i] = rnd() * (city.dists[r] || 1);
    sDir[i] = rnd() > 0.5 ? 1 : -1;
    const u = rnd();
    sStatus[i] = u < 0.44 ? ST.TRIP : u < 0.76 ? ST.IDLE : u < 0.94 ? ST.PICKUP : ST.CHARGE;
    sTimer[i] = 20 + rnd() * 300;
    sSpeed[i] = 6 + rnd() * 10;
    sTarget[i] = sSpeed[i];
    sLen[i] = (4 + ((rnd() * 8) | 0)) / 2;
    sBorn[i] = 1;
  }
}

/**
 * 一天中的出行结构（2035 年无人车队假设）：
 *   载客占比 —— 凌晨 3 点约 12%，早晚高峰约 62%，午间约 45%
 *   充电占比 —— 夜间集中补能（约 18%），白天约 4%
 * 返回累计阈值 [载客, 空驶, 接驾]，剩余为充电。
 */
function stateMix() {
  const h = tod / 60;
  const peak = Math.max(0, 1 - Math.abs(h - 8) / 2.0) + Math.max(0, 1 - Math.abs(h - 18) / 2.4);
  const night = Math.max(0, 1 - Math.abs(((h + 21) % 24) - 6) / 4);   // 0~6 点高
  const trip = 0.12 + 0.33 * (1 - night) + 0.17 * Math.min(1, peak);
  const charge = 0.04 + 0.14 * night;
  const pickup = 0.08 + 0.10 * Math.min(1, peak);
  const idle = Math.max(0.05, 1 - trip - charge - pickup);
  return [trip, trip + idle, trip + idle + pickup];
}

/** 潮汐方向由时刻自动决定：早高峰朝心，晚高峰离心；手动设置时以手动为准 */
function autoTide() {
  if (tideManual) return tide;
  const h = tod / 60;
  if (h >= 6.5 && h <= 10) return 1;
  if (h >= 16.5 && h <= 20) return -1;
  return 0;
}

/** 高峰期拥堵与潮汐方向 */
function congestionFactor() {
  const hour = tod / 60;
  const peak = Math.max(0, 1 - Math.abs(hour - 8) / 2.2) + Math.max(0, 1 - Math.abs(hour - 18) / 2.2);
  return 1 - 0.42 * Math.min(1, peak);
}

/**
 * 在路线的累计长度数组里二分定位线段。
 * cum[k] 是「本路线起点到第 k 段终点」的累计长度（MC 单位），每条路线从 0 重新累计。
 */
function findSeg(city, pos, lo, hi) {
  let a = lo, b = hi;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (city.cum[mid] < pos) a = mid + 1; else b = mid;
  }
  return Math.min(a, hi - 1);
}

/** 米/秒 → MC 单位/秒。BD09MC 在中国纬度带上约为实际米数的 1.15~1.3 倍 */
const MC_PER_M = 1.25;

/** 选一条穿过市中心、足够长的路线作为救护车行驶路线 */
function startCorridor(cityId) {
  // 大城市的数据被拆成多帧下发，同一座城在 cities 里有多段：在所有分段里挑路线，让行也覆盖所有分段
  // （只看第一段时，上海 / 广州 / 深圳的第一段恰好没有合格路线，生命通道开不起来 —— 实测）
  const cis = [];
  cities.forEach((c, i) => { if (c.id === cityId) cis.push(i); });
  if (!cis.length) return;
  // 选「端点直线距离」长、且穿过市中心附近的路线：
  // 随机游走生成的路线可能走一段再原路折返，按路程长度选会挑到在屏幕上缩成一小截的往返路线。
  const dispOf = (c, r) => {
    const v0 = c.starts[r], v1 = c.starts[r + 1] - 1;
    return v1 - v0 < 4 ? 0 : Math.hypot(c.xs[v1] - c.xs[v0], c.ys[v1] - c.ys[v0]) / 10;   // MC
  };
  // 门槛自适应：一般要求端点直线距离 ≥ 6000 MC（约 5 km）；路线普遍偏短的城市（深圳最长只有 5587）
  // 退到「本城最长路线的 60%」，保证每座城都开得出生命通道、且有足够候选挑到穿过市区的那条
  let maxDisp = 0;
  for (const cj of cis) for (let r = 0; r < cities[cj].routeCount; r++) maxDisp = Math.max(maxDisp, dispOf(cities[cj], r));
  const minDisp = Math.min(6000, maxDisp * 0.6);
  // 车流密度网格（约 300 m 一格）：按每辆车当前所在线段的起点估位置。
  // 用来挑「车多的路」—— 只按离市中心近来挑，上海 / 深圳会挑到车很少的路，看不出让行（实测平均 2–3 辆）
  const CELL = 400, dens = new Map();
  const cellKey = (x, y) => (Math.floor(x / CELL) + 50000) * 100000 + (Math.floor(y / CELL) + 50000);
  const cset = new Set(cis);
  for (let i = 0; i < activeCount; i++) {
    if (!cset.has(sCity[i])) continue;
    const c = cities[sCity[i]], ri = sRoute[i];
    const lo = c.segOff[ri], hi = c.segOff[ri + 1];
    const vi = hi - lo < 1 ? c.starts[ri] : c.starts[ri] + (findSeg(c, sPos[i], lo, hi) - lo);
    const k = cellKey(c.ox + c.xs[vi] / 10, c.oy + c.ys[vi] / 10);
    dens.set(k, (dens.get(k) || 0) + 1);
  }
  let best = -1, bestScore = -Infinity, ci = -1;
  for (const cj of cis) {
  const c = cities[cj];
  for (let r = 0; r < c.routeCount; r++) {
    const v0 = c.starts[r], v1 = c.starts[r + 1] - 1;
    if (v1 - v0 < 4) continue;
    const disp = dispOf(c, r);
    if (disp < minDisp) continue;
    // 沿线平均车流密度 + 离市中心距离 + 顺直度
    let near = Infinity, d = 0, len = 0;
    for (let k = v0; k <= v1; k++) {
      near = Math.min(near, Math.hypot(c.xs[k], c.ys[k]) / 10);
      d += dens.get(cellKey(c.ox + c.xs[k] / 10, c.oy + c.ys[k] / 10)) || 0;
      if (k > v0) len += Math.hypot(c.xs[k] - c.xs[k - 1], c.ys[k] - c.ys[k - 1]) / 10;
    }
    const avgDens = d / (v1 - v0 + 1);
    // 顺直度 = 端点直线距离 ÷ 路线长度：随机游走会掉头、来回折，追车镜头跟着反向就会整圈打转（实测上海一条路线 20 秒转了 365°）
    const straight = disp / Math.max(len, disp);
    if (straight < 0.6) continue;                    // 顺直度作硬门槛：过了门槛再比车流
    // 车多优先，其次够长、穿过市区
    const score = avgDens * straight * (Math.min(disp, 12000) / 12000) / (1 + near / 25000);
    if (score > bestScore) { bestScore = score; best = r; ci = cj; }
  }
  }
  if (best < 0) return;
  const c = cities[ci];
  const pts = [], cum = [0];
  for (let k = c.starts[best]; k < c.starts[best + 1]; k++) {
    pts.push(c.ox + c.xs[k] / 10, c.oy + c.ys[k] / 10);
    if (k > c.starts[best]) {
      const n = pts.length;
      cum.push(cum[cum.length - 1] + Math.hypot(pts[n - 2] - pts[n - 4], pts[n - 1] - pts[n - 3]));
    }
  }
  pendingCorridor = null;
  const K = EVENT_KINDS[corridorKind];
  corridor = { ci, cis, ri: best, s: 0, len: cum[cum.length - 1], pts, cum, t0: performance.now(),
    kind: corridorKind, speed: K.speed, ahead: K.ahead, width: K.width, tail: (K.units - 1) * CONVOY_GAP };
  self.postMessage({ t: 'corridor', on: true, kind: corridor.kind, units: EVENT_KINDS[corridor.kind].units, gap: CONVOY_GAP, pts: new Float32Array(pts).buffer, cum: new Float32Array(cum).buffer, len: corridor.len });
}

/** 救护车推进 + 前方车辆让行：靠边停车、变红；救护车驶过后恢复 */
function stepCorridor(dtSec, snapBuf) {
  if (!corridor) return;
  corridor.s += corridor.speed * MC_PER_M * dtSec;
  // 车队最后一辆也驶出终点后才解除
  if (corridor.s > corridor.len + corridor.tail + 800) {
    self.postMessage({ t: 'corridor', on: false, kind: corridor.kind });
    corridor = null;
    return;
  }
  const { pts, cum } = corridor;
  // 找到救护车所在线段，以及前方让行区间覆盖的线段
  // 让行区间：从车队尾车到头车前方 ahead；头车所在线段 kh 用于上报位置
  let k0 = 0;
  while (k0 < cum.length - 2 && cum[k0 + 1] < corridor.s - corridor.tail) k0++;
  let kh = k0;
  while (kh < cum.length - 2 && cum[kh + 1] < corridor.s) kh++;
  let k1 = kh;
  while (k1 < cum.length - 2 && cum[k1 + 1] < corridor.s + corridor.ahead) k1++;
  const W = corridor.width;
  const f32 = new Float32Array(snapBuf);
  const u8 = new Uint8Array(snapBuf);
  let yielded = 0;
  for (const cj of corridor.cis) {
  const c = cities[cj];
  const end = c.start + c.count;
  for (let i = c.start; i < end; i++) {
    const x = f32[i * 4], y = f32[i * 4 + 1];
    let best = Infinity, nx = 0, ny = 0;
    for (let k = k0; k <= k1; k++) {
      const ax = pts[k * 2], ay = pts[k * 2 + 1], bx = pts[k * 2 + 2], by = pts[k * 2 + 3];
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      const px = ax + dx * t, py = ay + dy * t;
      const d = Math.hypot(x - px, y - py);
      if (d < best) { best = d; nx = x - px; ny = y - py; }
    }
    if (best < W) {
      // 让行：速度归零、标记为让行状态、向路外侧平移 ~10 m（视觉上「分开一条路」）
      sTarget[i] = 0;
      sSpeed[i] *= 0.2;
      sStatus[i] = ST.RESCUE;
      sTimer[i] = Math.max(sTimer[i], 6);
      const len = Math.hypot(nx, ny) || 1;
      const push = (W - best) * 0.35 + 12;
      f32[i * 4] = x + (nx / len) * push;
      f32[i * 4 + 1] = y + (ny / len) * push;
      u8[i * 16 + 13] = ST.RESCUE;
      yielded++;
    }
  }
  }
  // 头车位置
  const kk = kh;
  const segLen = Math.max(0.001, cum[kk + 1] - cum[kk]);
  const f = Math.max(0, Math.min(1, (corridor.s - cum[kk]) / segLen));
  const ax = pts[kk * 2] + (pts[kk * 2 + 2] - pts[kk * 2]) * f;
  const ay = pts[kk * 2 + 1] + (pts[kk * 2 + 3] - pts[kk * 2 + 1]) * f;
  self.postMessage({ t: 'ambulance', x: ax, y: ay, s: corridor.s, len: corridor.len, yielded });
}

/** 潮汐：每步抽样 1.5% 的车辆，让载客车辆偏向朝心（早高峰）或离心（晚高峰）行驶 */
function applyTide() {
  const tide = autoTide();
  if (!tide || !activeCount) return;
  const k = Math.max(1, (activeCount * 0.015) | 0);
  for (let j = 0; j < k; j++) {
    const i = (Math.random() * activeCount) | 0;
    const city = cities[sCity[i]];
    if (!city) continue;
    // 只调整载客车辆：潮汐是「人」的流向
    if (sStatus[i] !== ST.TRIP) continue;
    const inner = city.meta[city.starts[sRoute[i]] * 2 + 1] === 1;
    sDir[i] = (tide > 0) === inner ? 1 : -1;
  }
}

function step(dtSec) {
  if (wasmOn) {
    const t0 = performance.now();
    const [pT, pI, pP] = stateMix();
    W.step(activeCount, citiesPtr, P.city, P.route, P.pos, P.dir, P.speed, P.status, P.timer, P.target, dtSec, congestionFactor(), pT, pI, pP);
    applyTide();
    return performance.now() - t0;
  }
  const t0 = performance.now();
  const cnt = activeCount;
  const con = congestionFactor();
  const [pT, pI, pP] = stateMix();
  for (let i = 0; i < cnt; i++) {
    sTimer[i] -= dtSec;
    if (sTimer[i] <= 0) {
      const u = Math.random();
      const st = u < pT ? ST.TRIP : u < pI ? ST.IDLE : u < pP ? ST.PICKUP : ST.CHARGE;
      sStatus[i] = st;
      sTimer[i] = 30 + Math.random() * 300;
      const f = st === ST.CHARGE ? 0 : st === ST.TRIP ? 1 : 0.45;
      sTarget[i] = (5 + Math.random() * 12) * f;
    }
    sSpeed[i] += (sTarget[i] - sSpeed[i]) * Math.min(1, dtSec * 0.7);
    const v = sSpeed[i] * con;
    const city = cities[sCity[i]];
    if (!city) continue;
    const ri = sRoute[i];
    const len = city.dists[ri] || 1;
    if (v <= 0.02) continue;
    let pos = sPos[i] + sDir[i] * v * MC_PER_M * dtSec;
    if (pos > len) { pos = len - (pos - len); sDir[i] = -1; }
    else if (pos < 0) { pos = -pos; sDir[i] = 1; }
    sPos[i] = pos;
  }
  applyTide();
  return performance.now() - t0;
}

function snapshot() {
  if (wasmOn) {
    W.snapshot(activeCount, citiesPtr, P.city, P.route, P.pos, P.speed, P.status, P.born, P.len, P.out);
    // 拷出一份可转移的 ArrayBuffer（WASM 内存本身不能转移）
    return W.memory.buffer.slice(P.out, P.out + Math.max(1, activeCount) * SNAP_STRIDE);
  }
  const cnt = activeCount;
  const buf = new ArrayBuffer(Math.max(1, cnt) * SNAP_STRIDE);
  const f32 = new Float32Array(buf);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < cnt; i++) {
    const city = cities[sCity[i]];
    const ri = sRoute[i];
    const lo = city.segOff[ri], hi = city.segOff[ri + 1];
    const pos = sPos[i];
    let ax, ay, bx, by, segLen = 1, segStart = 0;
    if (hi - lo < 1) { ax = bx = city.xs[city.starts[ri]]; ay = by = city.ys[city.starts[ri]]; }
    else {
      const k = findSeg(city, pos, lo, hi);
      segStart = k > lo ? city.cum[k - 1] : 0;
      const vi = city.starts[ri] + (k - lo);
      ax = city.xs[vi]; ay = city.ys[vi];
      bx = city.xs[vi + 1]; by = city.ys[vi + 1];
      segLen = Math.max(0.001, city.cum[k] - segStart);
    }
    const f = Math.max(0, Math.min(1, (pos - segStart) / segLen));
    const x = city.ox + (ax + (bx - ax) * f) / 10;
    const y = city.oy + (ay + (by - ay) * f) / 10;
    const dx = bx - ax, dy = by - ay;
    const o = i * SNAP_STRIDE;
    f32[i * 4] = x;
    f32[i * 4 + 1] = y;
    f32[i * 4 + 2] = Math.atan2(dy, dx);
    u8[o + 12] = Math.min(255, sSpeed[i] * 3.6);
    u8[o + 13] = sStatus[i];
    u8[o + 14] = sBorn[i];
    u8[o + 15] = sLen[i];
    sBorn[i] = 0;
  }
  return buf;
}

let last = performance.now();
function loop() {
  if (!running) return;
  if (activeCount === 0) { setTimeout(loop, 100); return; }
  const now = performance.now();
  const realDt = Math.min(0.5, (now - last) / 1000);
  last = now;
  const simDt = Math.min(2, realDt * timeScale);
  // 仿真时钟：按加速倍率推进（timeScale=60 即 1 秒 = 1 分钟）
  tod = (tod + (realDt * timeScale) / 60) % 1440;
  const stepMs = step(simDt);
  const tp = performance.now();
  const snap = snapshot();
  // 救护车按「未截断」的仿真时间推进：车辆步长为防瞬移被限制在 2 s，救护车需要真实加速
  stepCorridor(realDt * timeScale, snap);
  const packMs = performance.now() - tp;
  self.postMessage(
    { t: 'snap', data: snap, n: activeCount, stride: SNAP_STRIDE, stepMs, packMs, simMs, tod, wasm: wasmOn },
    [snap],
  );
  // 快照节拍固定 1 Hz：时间加速只改变每跳的位移，不改变上报频率
  setTimeout(loop, 1000);
}
