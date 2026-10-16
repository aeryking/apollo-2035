/**
 * 分块打包：把 490 个城市的小文件合并成若干「区域数据块」，每块几 MB。
 *
 * 为什么：
 *  - 490 次小请求的往返开销远大于数据本身（实测吞吐只有 1.4 MB/s）；
 *  - 合成大块后用 fetch 的 ReadableStream 逐块读取，读到一个完整帧就解析一个城市，
 *    下载、解析、上屏三者流水线重叠 —— 这才是真正的「边下载、边处理、边显示」。
 *
 * 结构：每个块 = 文件头 + [META 帧(城市 id) + 数据帧] × N + END 帧
 * 块内城市按权重降序：大城市先到，首屏最先看到最重要的数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { FrameWriter, FRAME, KIND, HEADER_BYTES, FRAME_HEADER_BYTES } from '../src/stream/binary.js';

const DIR = path.resolve('data-build.noindex');   // 逐城中间产物
const PUB = path.resolve('public/data');   // 分块输出
const man = JSON.parse(fs.readFileSync(path.join(PUB, 'cities.json'), 'utf8'));
const PACK_BYTES = Number(process.env.PACK_MB || 3) * 1024 * 1024;

/** 读出单城文件里的数据帧 payload */
function payloadOf(file) {
  const buf = fs.readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = dv.getUint32(HEADER_BYTES + 1, true);
  return buf.subarray(HEADER_BYTES + FRAME_HEADER_BYTES, HEADER_BYTES + FRAME_HEADER_BYTES + len);
}

/* ------------------- 大城市拆小帧：首屏不必等整城下载完 ------------------- */
const MAX_SEGS_PER_FRAME = 8192;     // 路网：每帧 ≤ 8192 段 ≈ 256 KB
const MAX_ROUTES_PER_FRAME = 600;    // 路线池：每帧 ≤ 600 条路线

/** 路网 payload：[32B 头: nSeg, 8, real, cx f64, cy f64] + float32 × 8 × nSeg */
function splitLines(p) {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const nSeg = dv.getUint32(0, true);
  if (nSeg <= MAX_SEGS_PER_FRAME) return [p];
  const out = [];
  for (let s0 = 0; s0 < nSeg; s0 += MAX_SEGS_PER_FRAME) {
    const n = Math.min(MAX_SEGS_PER_FRAME, nSeg - s0);
    const head = Buffer.from(p.subarray(0, 32));
    head.writeUInt32LE(n, 0);
    out.push(Buffer.concat([head, p.subarray(32 + s0 * 32, 32 + (s0 + n) * 32)]));
  }
  return out;
}

/** 路线池 payload 拆分：每个子块都是自洽的完整结构（索引重新从 0 计） */
function splitRoutes(p) {
  const buf = p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength);
  const dv = new DataView(buf);
  const R = dv.getUint32(0, true), V = dv.getUint32(4, true), S = dv.getUint32(8, true);
  if (R <= MAX_ROUTES_PER_FRAME) return [{ payload: p, fraction: 1 }];
  let o = 32;
  const starts = new Uint32Array(buf, o, R + 1); o += 4 * (R + 1);
  const dists = new Float32Array(buf, o, R); o += 4 * R;
  const segOff = new Uint32Array(buf, o, R + 1); o += 4 * (R + 1);
  const cum = new Float32Array(buf, o, S); o += 4 * S;
  const xs = new Int32Array(buf, o, V); o += 4 * V;
  const ys = new Int32Array(buf, o, V); o += 4 * V;
  const meta = new Uint8Array(buf, o, V * 2);
  const out = [];
  for (let r0 = 0; r0 < R; r0 += MAX_ROUTES_PER_FRAME) {
    const r1 = Math.min(R, r0 + MAX_ROUTES_PER_FRAME);
    const v0 = starts[r0], v1 = starts[r1], g0 = segOff[r0], g1 = segOff[r1];
    const nR = r1 - r0, nV = v1 - v0, nS = g1 - g0;
    const st = new Uint32Array(nR + 1), so = new Uint32Array(nR + 1);
    for (let i = 0; i <= nR; i++) { st[i] = starts[r0 + i] - v0; so[i] = segOff[r0 + i] - g0; }
    const head = Buffer.from(new Uint8Array(buf, 0, 32));
    head.writeUInt32LE(nR, 0); head.writeUInt32LE(nV, 4); head.writeUInt32LE(nS, 8);
    const sub = Buffer.concat([
      head,
      Buffer.from(st.buffer), Buffer.from(dists.slice(r0, r1).buffer),
      Buffer.from(so.buffer), Buffer.from(cum.slice(g0, g1).buffer),
      Buffer.from(xs.slice(v0, v1).buffer), Buffer.from(ys.slice(v0, v1).buffer),
      Buffer.from(meta.slice(v0 * 2, v1 * 2).buffer),
    ]);
    out.push({ payload: sub, fraction: nR / R });
  }
  return out;
}

function buildPacks(prefix, kind, frameType) {
  // 真实路网的大城市各自独占一块；其余按权重降序装箱
  const sorted = [...man].sort((a, b) => b.weight - a.weight);
  const packs = [];
  let cur = null;
  for (const c of sorted) {
    const f = path.join(DIR, `${prefix}-${c.id}.bin`);
    if (!fs.existsSync(f)) continue;
    const p = payloadOf(f);
    if (!cur || cur.bytes + p.length > PACK_BYTES || (c.real && cur.items.length)) {
      cur = { items: [], bytes: 0, weight: 0 };
      packs.push(cur);
    }
    cur.items.push({ id: c.id, payload: p });
    cur.bytes += p.length;
    cur.weight += c.weight;
    if (c.real) cur = null;   // 大城市独占
  }
  const index = [];
  packs.forEach((pk, i) => {
    const w = new FrameWriter(kind, pk.items.length, [i, pk.weight, 0, 0]);
    for (const it of pk.items) {
      // 大城市拆成若干小帧；每个数据帧前一个 META 帧：「城市 id|本帧占比」
      const parts = frameType === FRAME.ROAD_CHUNK
        ? splitLines(it.payload).map((payload, i, a) => ({ payload, fraction: 1 / a.length }))
        : splitRoutes(it.payload);
      for (const part of parts) {
        w.addFrame(FRAME.META, new TextEncoder().encode(`${it.id}|${part.fraction.toFixed(6)}`).buffer);
        const pl = part.payload;
        w.addFrame(frameType, pl.buffer.slice(pl.byteOffset, pl.byteOffset + pl.length));
      }
    }
    const out = w.end();
    const name = `${prefix}-pack-${String(i).padStart(2, '0')}.bin`;
    fs.writeFileSync(path.join(PUB, name), out);
    index.push({ file: name, cities: pk.items.map((x) => x.id), bytes: out.length, weight: pk.weight });
  });
  return index;
}

const routes = buildPacks('city', KIND.TRAJECTORY, FRAME.TRAJ_CHUNK);
const lines = buildPacks('lines', KIND.ROADS, FRAME.ROAD_CHUNK);
fs.writeFileSync(path.join(PUB, 'packs.json'), JSON.stringify({ routes, lines }, null, 1));
const sum = (a) => (a.reduce((s, x) => s + x.bytes, 0) / 1048576).toFixed(1);
console.log(`路线池：${routes.length} 块，${sum(routes)} MB；路网线：${lines.length} 块，${sum(lines)} MB`);
console.log('块大小(MB)：', routes.map((r) => (r.bytes / 1048576).toFixed(1)).join(' '));
