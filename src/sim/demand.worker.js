/**
 * 需求预测 Worker：在城市六边形网格上计算「15 分钟后」的出行需求热度。
 *
 * 模型（演示用的可解释模型，而非黑盒）：
 *   需求 = Σ 热点权重(时刻) × 高斯衰减(距离) + 低频噪声
 *   早高峰需求集中在居住区（出发地），晚高峰转移到商务区，火车站/机场全天有基础需求。
 * 每秒输出一次全网格数值（Float32Array，零拷贝转移），主线程只更新一个小缓冲区。
 */
import { ll2rel } from '../core/projection.js';

// 北京主要需求热点（BD09 经纬度）。type: home 居住区 / work 商务区 / hub 交通枢纽
const HOTSPOTS = [
  { name: '国贸 CBD', at: [116.4675, 39.9145], type: 'work', w: 1.0, r: 2.2 },
  { name: '金融街', at: [116.3665, 39.9215], type: 'work', w: 0.85, r: 1.6 },
  { name: '中关村', at: [116.3225, 39.9895], type: 'work', w: 0.9, r: 2.4 },
  { name: '望京', at: [116.4815, 40.0025], type: 'work', w: 0.75, r: 2.0 },
  { name: '西二旗', at: [116.3195, 40.0595], type: 'work', w: 0.7, r: 1.8 },
  { name: '亦庄', at: [116.5125, 39.7985], type: 'work', w: 0.55, r: 2.4 },
  { name: '回龙观', at: [116.3445, 40.0805], type: 'home', w: 0.9, r: 2.6 },
  { name: '天通苑', at: [116.4285, 40.0765], type: 'home', w: 0.95, r: 2.4 },
  { name: '通州', at: [116.6635, 39.9155], type: 'home', w: 0.85, r: 3.0 },
  { name: '望京西', at: [116.4505, 39.9935], type: 'home', w: 0.5, r: 1.6 },
  { name: '丰台', at: [116.2935, 39.8625], type: 'home', w: 0.6, r: 2.8 },
  { name: '石景山', at: [116.2295, 39.9125], type: 'home', w: 0.55, r: 2.4 },
  { name: '北京站', at: [116.4335, 39.9085], type: 'hub', w: 0.7, r: 0.9 },
  { name: '北京西站', at: [116.3285, 39.9015], type: 'hub', w: 0.8, r: 1.0 },
  { name: '北京南站', at: [116.3855, 39.8715], type: 'hub', w: 0.75, r: 1.0 },
  { name: '首都机场 T3', at: [116.6175, 40.0585], type: 'hub', w: 0.85, r: 1.4 },
];

let cells = null;     // Float32Array [x, y] × n（图层坐标）
let hotRel = null;    // 热点图层坐标
let activeHot = HOTSPOTS;
let tod = 480;
let timer = null;
const HEX_R_M = 520;            // 六边形外接圆半径（米）
let MC_PER_M = 1.3;             // BD09MC / 米 ≈ 1/cos(纬度)，按城市纬度在 build 里重算

function weightByTime(type, h) {
  const am = Math.max(0, 1 - Math.abs(h - 8) / 1.8);
  const pm = Math.max(0, 1 - Math.abs(h - 18.3) / 2.0);
  const day = h > 9 && h < 17 ? 0.5 : 0.15;
  if (type === 'home') return 0.25 + 1.2 * am + 0.2 * pm;      // 早高峰从家出发
  if (type === 'work') return 0.2 + 0.25 * am + 1.25 * pm + day; // 晚高峰从单位出发
  return 0.55 + 0.25 * (am + pm);                                // 枢纽全天
}

/**
 * 非北京城市：没有逐个标注的真实地点，按城市结构生成可复现的热点 ——
 * 市中心若干商务区、外圈一环居住区、边缘两三个交通枢纽（与北京模型同一套类型与时变权重）。
 */
function genHotspots(cityId, center) {
  let seed = 0;
  for (const ch of cityId) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const kmLng = 1 / (111.32 * Math.cos((center[1] * Math.PI) / 180)), kmLat = 1 / 110.54;
  const at = (dist, ang) => [center[0] + Math.cos(ang) * dist * kmLng, center[1] + Math.sin(ang) * dist * kmLat];
  const out = [];
  for (let i = 0; i < 5; i++) out.push({ name: `商务区${i + 1}`, at: at(1 + rnd() * 5, rnd() * 6.283), type: 'work', w: 0.6 + rnd() * 0.4, r: 1.5 + rnd() * 1 });
  for (let i = 0; i < 7; i++) out.push({ name: `居住区${i + 1}`, at: at(8 + rnd() * 8, (i / 7) * 6.283 + rnd() * 0.6), type: 'home', w: 0.55 + rnd() * 0.4, r: 2 + rnd() * 1 });
  for (let i = 0; i < 3; i++) out.push({ name: `枢纽${i + 1}`, at: at(5 + rnd() * 12, rnd() * 6.283), type: 'hub', w: 0.65 + rnd() * 0.2, r: 1 });
  return out;
}

function build({ center, radiusKm, cityId = 'beijing' }) {
  MC_PER_M = 1 / Math.cos((center[1] * Math.PI) / 180);
  activeHot = cityId === 'beijing' ? HOTSPOTS : genHotspots(cityId, center);
  const c = ll2rel(center[0], center[1], [0, 0]);
  const R = HEX_R_M * MC_PER_M;
  const dx = Math.sqrt(3) * R, dy = 1.5 * R;
  const span = radiusKm * 1000 * MC_PER_M;
  const pts = [];
  let row = 0;
  for (let y = -span; y <= span; y += dy, row++) {
    const off = row % 2 ? dx / 2 : 0;
    for (let x = -span; x <= span; x += dx) {
      const px = x + off, py = y;
      if (px * px + py * py > span * span) continue;   // 圆形范围
      pts.push(c[0] + px, c[1] + py);
    }
  }
  cells = new Float32Array(pts);
  hotRel = activeHot.map((h) => ({ ...h, rel: ll2rel(h.at[0], h.at[1], [0, 0]) }));
  return { cells: cells.slice(), radius: R };
}

// 低频「噪声」：几组固定相位的正弦叠加，保证每秒变化平滑、可复现
function noise(x, y, t) {
  return 0.5 + 0.25 * Math.sin(x * 0.00031 + t * 0.7) * Math.cos(y * 0.00027 - t * 0.5)
    + 0.25 * Math.sin((x + y) * 0.00017 + t * 0.3);
}

function compute() {
  if (!cells) return;
  const t0 = performance.now();
  const n = cells.length / 2;
  const out = new Float32Array(n);
  const h = ((tod + 15) / 60) % 24;           // 预测 15 分钟之后
  const t = tod / 30;
  const weights = hotRel.map((p) => p.w * weightByTime(p.type, h));
  let max = 1e-6;
  for (let i = 0; i < n; i++) {
    const x = cells[i * 2], y = cells[i * 2 + 1];
    let v = 0;
    for (let k = 0; k < hotRel.length; k++) {
      const p = hotRel[k];
      const d2 = ((x - p.rel[0]) ** 2 + (y - p.rel[1]) ** 2) / ((p.r * 1000 * MC_PER_M) ** 2);
      v += weights[k] * Math.exp(-d2);
    }
    v = v * (0.75 + 0.5 * noise(x, y, t));
    out[i] = v;
    if (v > max) max = v;
  }
  for (let i = 0; i < n; i++) out[i] /= max;
  self.postMessage({ t: 'values', data: out.buffer, tod, ms: performance.now() - t0 }, [out.buffer]);
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.cmd === 'init') {
    const g = build(m);
    self.postMessage({ t: 'grid', cells: g.cells.buffer, radius: g.radius, hotspots: activeHot.map((h) => ({ name: h.name, at: h.at, type: h.type })) }, [g.cells.buffer]);
    compute();
    clearInterval(timer);
    timer = setInterval(compute, 1000);
  } else if (m.cmd === 'tod') {
    tod = m.tod;
  } else if (m.cmd === 'stop') {
    clearInterval(timer);
  }
};
