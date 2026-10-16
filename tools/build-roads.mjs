/**
 * 路网构建：OSM/合成路网 → ① 渲染用线段 ② 仿真用路线池
 *
 * 输入：data-src.noindex/osm-*.json（真实路网）、data-src.noindex/datav/*（城市边界与中心点）
 * 输出：public/data/city-<id>.bin（含路线池与渲染线段，供流式加载）
 *
 * 坐标：WGS84 → GCJ02 → BD09 → BD09MC 相对偏移（图层坐标系）
 * 数据许可：© OpenStreetMap contributors (ODbL)；行政区划 © DataV.GeoAtlas
 */
import fs from 'node:fs';
import path from 'node:path';
import { ll2mc, BASE_MC, wgs2bd } from '../src/core/projection.js';
import { FrameWriter, KIND, FRAME } from '../src/stream/binary.js';
import { popOf } from './population.mjs';

const SRC = path.resolve('data-src.noindex');
const OUT = path.resolve('data-build.noindex');      // 逐城中间产物
const PUB = path.resolve('public/data');      // 前端清单
fs.mkdirSync(OUT, { recursive: true });

/** 城市清单：weight 为车辆分配权重；osm 指向真实路网文件；无 osm 的走合成路网 */
const CITIES = [
  { id: 'beijing', name: '北京', center: [116.407, 39.905], weight: 100, osm: 'osm-beijing-core.json', osmExtra: 'osm-beijing-ring.json', maxRoutes: 9000 },
  { id: 'wuhan', name: '武汉', center: [114.305, 30.593], weight: 62, osm: 'osm-wuhan.json', maxRoutes: 6000 },
  { id: 'shanghai', name: '上海', center: [121.473, 31.230], weight: 95, osm: 'osm-shanghai.json', maxRoutes: 7000 },
  { id: 'shenzhen', name: '深圳', center: [114.057, 22.543], weight: 80, osm: 'osm-shenzhen.json', maxRoutes: 6000 },
  { id: 'guangzhou', name: '广州', center: [113.264, 23.129], weight: 78, osm: 'osm-guangzhou.json', maxRoutes: 6000 },
  { id: 'chengdu', name: '成都', center: [104.066, 30.573], weight: 75, osm: 'osm-chengdu.json', maxRoutes: 6000 },
  { id: 'chongqing', name: '重庆', center: [106.551, 29.563], weight: 85, osm: 'osm-chongqing.json', maxRoutes: 7000 },
  { id: 'hangzhou', name: '杭州', center: [120.155, 30.274], weight: 70, osm: 'osm-hangzhou.json', maxRoutes: 6000 },
];

const ROADS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
// 匝道（*_link，立交的主体）比主路低一档：线宽窄一点、显示层级照旧
const ROAD_CLASS = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, residential: 5, synthetic: 6, motorway_link: 1, trunk_link: 2, primary_link: 3 };

/* ---------------- 从 DataV 边界生成合成城市（有中心点与面积） ---------------- */
function loadCitiesFromDatav() {
  const dir = path.join(SRC, 'datav');
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^(\d+)_full\.json$/.test(f)) continue;
    const code = f.match(/^(\d+)_full/)[1];
    if (code === '100000') continue;
    const fc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const feat of fc.features) {
      const p = feat.properties || {};
      if (!p.center && !p.centroid) continue;
      const c = p.center || p.centroid;
      // 面积（度²）→ 粗略侧向尺度
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      const walk = (a) => {
        if (typeof a[0] === 'number') {
          minX = Math.min(minX, a[0]); maxX = Math.max(maxX, a[0]);
          minY = Math.min(minY, a[1]); maxY = Math.max(maxY, a[1]);
        } else a.forEach(walk);
      };
      walk(feat.geometry.coordinates);
      out.push({
        id: `c${p.adcode || code}${out.length}`,
        name: p.name,
        adcode: p.adcode,
        parent: code,
        center: c,
        weight: popOf(p.name, p.adcode),
        span: [maxX - minX, maxY - minY],
        synthetic: true,
      });
    }
  }
  return out;
}

/* ---------------- OSM → 图 ---------------- */
function readOsm(file) {
  if (!fs.existsSync(file)) return null;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return j.elements.filter((e) => e.type === 'way' && e.geometry && e.geometry.length > 1);
}

/** 坐标量化键：5 位小数 ≈ 1.1 m */
const key = (lng, lat) => `${lng.toFixed(5)},${lat.toFixed(5)}`;

function buildGraph(ways) {
  const nodes = new Map(); // key -> {x,y (BD09 经纬度), edges:[{to, len, class, way}]}
  const getNode = (lng, lat) => {
    const k = key(lng, lat);
    let n = nodes.get(k);
    if (!n) { n = { lng, lat, edges: [] }; nodes.set(k, n); }
    return n;
  };
  const segs = []; // 渲染用线段：{a:[lng,lat], b:[lng,lat], cls, cum}
  for (const w of ways) {
    const cls = ROAD_CLASS[w.tags?.highway] ?? 6;
    const oneway = w.tags?.oneway === 'yes' || w.tags?.['highway'] === 'motorway';
    let cum = 0;
    let prev = null;
    for (const g of w.geometry) {
      const bd = wgs2bd(g.lon, g.lat);
      const n = getNode(bd[0], bd[1]);
      if (prev) {
        const dLng = (bd[0] - prev.lng) * 111320 * Math.cos((bd[1] * Math.PI) / 180);
        const dLat = (bd[1] - prev.lat) * 110540;
        const len = Math.hypot(dLng, dLat);
        if (len > 0.5) {
          prev.edges.push({ to: n, len, cls, oneway });
          if (!oneway) n.edges.push({ to: prev, len, cls, oneway });
          segs.push({ ax: prev.lng, ay: prev.lat, bx: bd[0], by: bd[1], cls, cum });
          cum += len;
        }
      }
      prev = n;
    }
  }
  return { nodes, segs };
}

/**
 * 随机游走生成路线：优先直行，模拟车辆沿道路行进。
 * 返回 {verts: [[lng,lat]...], dist, bearingStart}
 */
function walkRoute(nodes, rnd, steps = 26) {
  const keys = nodes._keyList;
  let cur = nodes.get(keys[(rnd() * keys.length) | 0]);
  const verts = [[cur.lng, cur.lat]];
  let vx = 0, vy = 0;
  let total = 0;
  let stepCls = null;
  for (let s = 0; s < steps; s++) {
    const es = cur.edges;
    if (!es.length) break;
    // 挑选下一步：与前一步方向夹角小者优先
    let best = null, bestScore = -1e9;
    const wantStraight = rnd() > 0.25;
    for (let i = 0; i < Math.min(es.length, 6); i++) {
      const e = es[(rnd() * es.length) | 0];
      const dx = (e.to.lng - cur.lng) * 111320 * Math.cos((cur.lat * Math.PI) / 180);
      const dy = (e.to.lat - cur.lat) * 110540;
      const len = Math.hypot(dx, dy) || 1;
      const cos = total > 0 ? (dx / len) * vx + (dy / len) * vy : 1;
      const score = (wantStraight ? cos * 2 : -cos) + rnd() * 0.8 - e.len / 3000;
      if (score > bestScore) { bestScore = score; best = { e, dx, dy, len }; }
    }
    if (!best) break;
    vx = best.dx / best.len; vy = best.dy / best.len;
    if (stepCls === null) stepCls = best.e.cls;
    cur = best.e.to;
    verts.push([cur.lng, cur.lat]);
    total += best.len;
    if (total > 12000) break;
  }
  return { verts, dist: total, cls: stepCls ?? ROAD_CLASS.synthetic };
}

/**
 * 合成城市路网：一组固定道路（环路 + 放射路 + 方格路），车辆在固定道路上行驶。
 * 道路是确定的，车辆路线就是这些道路本身 —— 路网线图层直接用同一组折线，
 * 保证「车跑在画出来的路上」，也让远景下城市呈现清晰的环放结构。
 */
function synthRoutes(city, rnd) {
  const [cx, cy] = city.center;
  const [sw, sh] = city.span || [0.2, 0.2];
  // 建成区半径：与人口挂钩（大城市更大），并受行政区尺度约束
  const popR = 0.03 + Math.sqrt(Math.max(30, city.weight)) * 0.0028;   // 度
  const R = Math.min(popR, Math.min(sw, sh) * 0.35);
  const A = 111.32 * Math.cos((cy * Math.PI) / 180), B = 110.54; // 度 → 公里
  const routes = [];
  const km = (verts) => {
    let d = 0;
    for (let i = 1; i < verts.length; i++) d += Math.hypot((verts[i][0] - verts[i - 1][0]) * A, (verts[i][1] - verts[i - 1][1]) * B) * 1000;
    return d;
  };
  // 环路：3 条
  for (const k of [0.3, 0.62, 1.0]) {
    const r = R * k, verts = [];
    const n = 48;
    for (let s = 0; s <= n; s++) {
      const a = (s / n) * Math.PI * 2;
      const wob = 1 + 0.06 * Math.sin(a * 3 + k * 7);
      verts.push([cx + (Math.cos(a) * r * wob), cy + (Math.sin(a) * r * wob) * (A / B)]);
    }
    routes.push({ verts, dist: km(verts), cls: k < 0.5 ? 1 : 2 });
  }
  // 放射路：8~12 条，穿过城区延伸到外环外
  const nRad = 8 + Math.floor(rnd() * 5);
  for (let i = 0; i < nRad; i++) {
    const a = (i / nRad) * Math.PI * 2 + rnd() * 0.25;
    const verts = [];
    for (let s = 0; s <= 16; s++) {
      const r = R * (0.05 + 1.25 * (s / 16));
      const bend = Math.sin(s * 0.45 + i) * 0.035;
      verts.push([cx + Math.cos(a + bend) * r, cy + Math.sin(a + bend) * r * (A / B)]);
    }
    routes.push({ verts, dist: km(verts), cls: 2 });
  }
  // 方格路：中心城区棋盘格
  const step = R * 0.22;
  for (let g = -3; g <= 3; g++) {
    const h = [], v = [];
    for (let s = -4; s <= 4; s++) {
      h.push([cx + s * step, cy + g * step * (A / B)]);
      v.push([cx + g * step, cy + s * step * (A / B)]);
    }
    routes.push({ verts: h, dist: km(h), cls: 3 });
    routes.push({ verts: v, dist: km(v), cls: 3 });
  }
  return routes;
}

/** 简易可复现随机 */
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------- 主流程 ------------------------------- */
const datavCities = loadCitiesFromDatav();
console.log('DataV 城市数', datavCities.length);

const datavById = new Map(datavCities.map((c) => [c.name.replace(/[市省]$/, ''), c]));
const allCities = [];
for (const c of CITIES) {
  const fallbackSpan = datavById.get(c.name)?.span || [0.16, 0.16];
  allCities.push({ ...c, span: fallbackSpan, weight: popOf(c.name) });
}
// 直辖市在 DataV 里按区县划分（北京 16 区、上海 16 区…），这些区县若落在
// 真实路网城市的覆盖范围内，就不能再生成合成路网，否则会和真实道路叠在一起。
const REAL_RADIUS_DEG = 0.45;
const nearReal = (c) => CITIES.some((r) => Math.hypot(c.center[0] - r.center[0], c.center[1] - r.center[1]) < REAL_RADIUS_DEG);
// 直辖市（北京/天津/上海/重庆）的区县：整市合并成一个合成城市，避免 16 个碎片
const MUNI = { '110000': '北京', '120000': '天津', '310000': '上海', '500000': '重庆' };
const muniMerged = new Set();
for (const c of datavCities) {
  const short = c.name.replace(/[市]$/, '');
  if (CITIES.some((x) => x.name === short)) continue;
  if (nearReal(c)) continue;
  if (MUNI[c.parent]) {
    const m = MUNI[c.parent];
    if (CITIES.some((x) => x.name === m) || muniMerged.has(m)) continue;
    muniMerged.add(m);
    const all = datavCities.filter((x) => x.parent === c.parent);
    const cx = all.reduce((s, x) => s + x.center[0], 0) / all.length;
    const cy = all.reduce((s, x) => s + x.center[1], 0) / all.length;
    allCities.push({ ...c, id: `m${c.parent}`, name: m, center: [cx, cy], span: [0.5, 0.4], weight: popOf(m), synthetic: true });
    continue;
  }
  allCities.push({ ...c, synthetic: true });
}
const totalWeight = allCities.reduce((s, c) => s + c.weight, 0);
console.log(`城市总数 ${allCities.length}，权重合计 ${totalWeight}`);

let idx = 0;
const manifest = [];
for (const city of allCities) {
  const rnd = mulberry(1000 + idx * 7919);
  let routes = [];
  let segs = [];
  let real = false;

  const osmFiles = [city.osm, city.osmExtra].filter((f) => f && fs.existsSync(path.join(SRC, f)));
  if (osmFiles.length) {
    const ways = osmFiles.flatMap((f) => readOsm(path.join(SRC, f)) || []);
    const g = buildGraph(ways);
    g.nodes._keyList = [...g.nodes.keys()].filter((k) => g.nodes.get(k).edges.length > 1);
    segs = g.segs;
    real = true;
    const want = Math.min(city.maxRoutes || 6000, g.nodes._keyList.length * 3);
    let guard = 0;
    while (routes.length < want && guard < want * 6) {
      guard++;
      const r = walkRoute(g.nodes, rnd, 22 + ((rnd() * 16) | 0));
      if (r.dist > 300) routes.push(r);
    }
    console.log(`  [${city.name}] 真实路网: ${ways.length} ways, ${g.nodes.size} 节点, ${segs.length} 段, ${routes.length} 条路线`);
  } else {
    routes = synthRoutes(city, rnd);
  }

  // 网格空间排序：让流式加载先填满市中心，再向外扩散（视觉上从中心生长）
  routes.sort((a, b) => {
    const da = Math.hypot(a.verts[0][0] - city.center[0], a.verts[0][1] - city.center[1]);
    const db = Math.hypot(b.verts[0][0] - city.center[0], b.verts[0][1] - city.center[1]);
    return da - db;
  });

  // 打包：顶点存「百度墨卡托相对城市中心」的偏移，单位 0.1 MC（int32，±214 km）
  // 用精确投影而不是本地米制近似：后者在城市边缘会有上百米误差（墨卡托比例随纬度变化）
  let nVert = 0, nSeg = 0;
  for (const r of routes) { nVert += r.verts.length; nSeg += Math.max(0, r.verts.length - 1); }

  const starts = new Uint32Array(routes.length + 1);   // 路线 → 顶点区间
  const dists = new Float32Array(routes.length);       // 路线总长（MC 单位）
  const segOff = new Uint32Array(routes.length + 1);   // 路线 → 线段区间
  const cum = new Float32Array(nSeg);                  // 线段终点处的累计长度，二分查找用
  const xs = new Int32Array(nVert);
  const ys = new Int32Array(nVert);
  const meta = new Uint8Array(nVert * 2);              // [道路等级, 朝心标记]

  const cMc = ll2mc(city.center[0], city.center[1], [0, 0]);
  const mc = [0, 0];
  let vo = 0, so = 0;
  routes.forEach((r, i) => {
    starts[i] = vo;
    segOff[i] = so;
    let acc = 0, px = 0, py = 0;
    for (let k = 0; k < r.verts.length; k++) {
      ll2mc(r.verts[k][0], r.verts[k][1], mc);
      const x = Math.round((mc[0] - cMc[0]) * 10);
      const y = Math.round((mc[1] - cMc[1]) * 10);
      xs[vo] = x; ys[vo] = y;
      meta[vo * 2] = r.cls ?? ROAD_CLASS.synthetic;
      if (k > 0) { acc += Math.hypot(x - px, y - py) / 10; cum[so++] = acc; }
      px = x; py = y;
      vo++;
    }
    dists[i] = acc;
    const e0 = Math.hypot(xs[starts[i]], ys[starts[i]]);
    const e1 = Math.hypot(xs[vo - 1], ys[vo - 1]);
    const inward = e1 < e0 ? 1 : 0;
    for (let k = starts[i]; k < vo; k++) meta[k * 2 + 1] = inward;
  });
  starts[routes.length] = vo;
  segOff[routes.length] = so;

  const head = Buffer.alloc(32);
  const hv = new DataView(head.buffer);
  hv.setUint32(0, routes.length, true);
  hv.setUint32(4, nVert, true);
  hv.setUint32(8, nSeg, true);
  hv.setUint32(12, real ? 1 : 0, true);
  hv.setFloat64(16, cMc[0], true);   // 城市中心 BD09MC（float64，float32 会丢米级精度）
  hv.setFloat64(24, cMc[1], true);

  const payload = Buffer.concat([
    head,
    Buffer.from(starts.buffer, starts.byteOffset, starts.byteLength),
    Buffer.from(dists.buffer, dists.byteOffset, dists.byteLength),
    Buffer.from(segOff.buffer, segOff.byteOffset, segOff.byteLength),
    Buffer.from(cum.buffer, cum.byteOffset, cum.byteLength),
    Buffer.from(xs.buffer, xs.byteOffset, xs.byteLength),
    Buffer.from(ys.buffer, ys.byteOffset, ys.byteLength),
    Buffer.from(meta.buffer, meta.byteOffset, meta.byteLength),
  ]);

  const w = new FrameWriter(KIND.TRAJECTORY, routes.length, [city.center[0], city.center[1], city.weight, real ? 1 : 0]);
  w.addFrame(FRAME.TRAJ_CHUNK, payload);
  const buf = w.end();
  fs.writeFileSync(path.join(OUT, `city-${city.id}.bin`), buf);

  manifest.push({
    id: city.id, name: city.name, center: city.center, weight: city.weight, span: city.span,
    real, routes: routes.length, verts: nVert, segs: nSeg, bytes: buf.length,
  });
  idx++;
}

fs.mkdirSync(PUB, { recursive: true });
fs.writeFileSync(path.join(PUB, 'cities.json'), JSON.stringify(manifest, null, 1));
const tot = manifest.reduce((s, m) => s + m.bytes, 0);
console.log(`完成：${manifest.length} 城市，合计 ${(tot / 1e6).toFixed(1)} MB，${manifest.reduce((s, m) => s + m.verts, 0).toLocaleString()} 顶点`);
console.log('真实路网城市：', manifest.filter((m) => m.real).map((m) => m.name).join(' '));
