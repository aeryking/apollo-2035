/**
 * 路网线段构建：为「线」图层生成可直接进显存的线段包。
 *
 * 每段 8 个 float32（32 B）：
 *   ax, ay, bx, by  端点（相对城市中心的 BD09MC 偏移，单位 MC）
 *   cum0, cum1      沿折线的累计里程，用于流动光效的相位
 *   kind            道路等级（0 高速 … 4 三级路 6 合成）
 *   widthK          线宽系数
 *
 * 输出 public/data/lines-<cityId>.bin，与 city-<id>.bin 同城同序，
 * 流式加载时可以边下边画，先出网、再出车。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ll2mc, BASE_MC, wgs2bd } from '../src/core/projection.js';
import { FrameWriter, KIND, FRAME } from '../src/stream/binary.js';

const SRC = path.resolve('data-src.noindex');
const OUT = path.resolve('data-build.noindex');
const PUB = path.resolve('public/data');

const CITIES = JSON.parse(fs.readFileSync(path.join(PUB, 'cities.json'), 'utf8'));
// 匝道（*_link，立交的主体）比主路低一档：线宽窄一点、显示层级照旧
const ROAD_CLASS = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, residential: 5, synthetic: 6, motorway_link: 1, trunk_link: 2, primary_link: 3 };
const WIDTH_K = { 0: 1.6, 1: 1.35, 2: 1.1, 3: 0.85, 4: 0.7, 6: 0.8 };

function readOsm(file) {
  if (!fs.existsSync(file)) return null;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return j.elements.filter((e) => e.type === 'way' && e.geometry && e.geometry.length > 1);
}

/* 用与 build-roads 相同的可复现随机 */
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SOURCES = {
  beijing: ['osm-beijing-core.json', 'osm-beijing-ring.json'],
  wuhan: ['osm-wuhan.json'],
  shanghai: ['osm-shanghai.json'],
  shenzhen: ['osm-shenzhen.json'],
  guangzhou: ['osm-guangzhou.json'],
  chengdu: ['osm-chengdu.json'],
  chongqing: ['osm-chongqing.json'],
  hangzhou: ['osm-hangzhou.json'],
};

let totalSegs = 0, totalBytes = 0;
for (let ci = 0; ci < CITIES.length; ci++) {
  const city = CITIES[ci];
  const outFile = path.join(OUT, `lines-${city.id}.bin`);
  if (fs.existsSync(outFile)) { continue; }

  const c = ll2mc(city.center[0], city.center[1], [0, 0]);
  const segs = [];   // 顶点为图层绝对坐标（BD09MC - BASE_MC）   // [ax, ay, bx, by, cum0, cum1, kind, widthK]
  const mc = [0, 0];

  const push = (lng, lat, prev) => {
    ll2mc(lng, lat, mc);
    return [mc[0] - BASE_MC[0], mc[1] - BASE_MC[1]];
  };

  const files = SOURCES[city.id];
  if (files) {
    for (const f of files) {
      const ways = readOsm(path.join(SRC, f)) || [];
      for (const w of ways) {
        const kind = ROAD_CLASS[w.tags?.highway] ?? 6;
        const wd = WIDTH_K[kind] ?? 0.8;
        let prev = null, cum = 0;
        for (const g of w.geometry) {
          const bd = wgs2bd(g.lon, g.lat);
          const p = push(bd[0], bd[1]);
          if (prev) {
            const d = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
            if (d > 0.5) {
              segs.push(prev[0], prev[1], p[0], p[1], cum, cum + d, kind, wd);
              cum += d;
            }
          }
          prev = p;
        }
      }
    }
  } else {
    // 合成城市：直接用该城的车辆路线生成路网线段，保证「车一定跑在画出来的路上」
    const raw = fs.readFileSync(path.join(OUT, `city-${city.id}.bin`));
    const flen = raw.readUInt32LE(33);
    const pl = raw.buffer.slice(raw.byteOffset + 37, raw.byteOffset + 37 + flen);
    const dv = new DataView(pl);
    const R = dv.getUint32(0, true), V = dv.getUint32(4, true), S = dv.getUint32(8, true);
    const cxm = dv.getFloat64(16, true) - BASE_MC[0], cym = dv.getFloat64(24, true) - BASE_MC[1];
    let o = 32;
    const starts = new Uint32Array(pl, o, R + 1); o += 4 * (R + 1);
    o += 4 * R;                 // dists
    o += 4 * (R + 1);           // segOff
    o += 4 * S;                 // cum
    const xs = new Int32Array(pl, o, V); o += 4 * V;
    const ys = new Int32Array(pl, o, V); o += 4 * V;
    const vmeta = new Uint8Array(pl, o, V * 2);   // [道路等级, 朝心标记]
    // 路线互相重叠很多：按量化端点去重，避免同一条路画几十遍
    const seen = new Set();
    for (let r = 0; r < R; r++) {
      let cum = 0;
      for (let k = starts[r]; k < starts[r + 1] - 1; k++) {
        const ax = cxm + xs[k] / 10, ay = cym + ys[k] / 10, bx = cxm + xs[k + 1] / 10, by = cym + ys[k + 1] / 10;
        const key = `${Math.round(ax / 20)},${Math.round(ay / 20)},${Math.round(bx / 20)},${Math.round(by / 20)}`;
        const d = Math.hypot(bx - ax, by - ay);
        if (!seen.has(key) && d > 0.5) {
          seen.add(key);
          // 合成路网沿用路线的道路等级：环路/放射路（1、2）为干线，方格路（3）为支线
          const kind = vmeta[k * 2];
          segs.push(ax, ay, bx, by, cum, cum + d, kind, WIDTH_K[kind] ?? 0.8);
        }
        cum += d;
      }
    }
  }

  const nSeg = segs.length / 8;
  const head = Buffer.alloc(32);
  const hv = new DataView(head.buffer);
  hv.setUint32(0, nSeg, true);
  hv.setUint32(4, 8, true);                 // 每段浮点数
  hv.setUint32(8, city.real ? 1 : 0, true);
  hv.setFloat64(16, c[0], true);
  hv.setFloat64(24, c[1], true);

  const body = Buffer.from(new Float32Array(segs).buffer);
  const w = new FrameWriter(KIND.ROADS, nSeg, [city.center[0], city.center[1], nSeg, city.weight]);
  w.addFrame(FRAME.ROAD_CHUNK, Buffer.concat([head, body]));
  const buf = w.end();
  fs.writeFileSync(outFile, buf);
  totalSegs += nSeg; totalBytes += buf.length;
  if (ci % 100 === 0) process.stdout.write(`\r已生成 ${ci + 1}/${CITIES.length} 城，${(totalBytes / 1e6).toFixed(1)} MB`);
}

// 汇总真实路网片段的顺序信息写回 manifest
const man = JSON.parse(fs.readFileSync(path.join(PUB, 'cities.json'), 'utf8'));
for (const m of man) {
  const f = path.join(OUT, `lines-${m.id}.bin`);
  if (fs.existsSync(f)) m.lineBytes = fs.statSync(f).size;
}
fs.writeFileSync(path.join(PUB, 'cities.json'), JSON.stringify(man, null, 1));
console.log(`\n完成：线段合计 ${totalSegs.toLocaleString()}，字节 ${(totalBytes / 1e6).toFixed(1)} MB`);
