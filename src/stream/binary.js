/**
 * 流式二进制协议：文件头 + 定长帧
 *
 *   ┌──────────── 32 字节文件头 ────────────┐
 *   │ magic 'A35S' | ver u16 | kind u16     │
 *   │ count u32 | meta f32[4]               │
 *   └───────────────────────────────────────┘
 *   ┌─ 帧 ─┬─ type u8 ─┬─ len u32 ─┬─ payload ─┐
 *   └──────┴───────────┴───────────┴───────────┘
 *
 * 设计要点：
 *  - 帧是自描述的：Worker 拿到一个完整帧就能独立解析并转交主线程，
 *    不需要等整个文件下载完 → 这是「边下载、边处理、边显示」的基础。
 *  - 所有几何都是相对百度墨卡托基准（BASE_MC）的偏移，float32 直接进显存。
 *  - 定长记录 + 结构化数组，解析即零拷贝视图（subarray），不产生中间对象。
 */

export const MAGIC = 0x41333553; // 'A35S'
export const VERSION = 1;
export const HEADER_BYTES = 32;
export const FRAME_HEADER_BYTES = 5; // type u8 + len u32

export const KIND = { ROADS: 1, ZONES: 2, TRAJECTORY: 3, VEHICLES: 4, DEMAND: 5, HEXES: 6, STOPS: 7 };

export const FRAME = { ROAD_CHUNK: 1, ZONE_CHUNK: 2, FILL_CHUNK: 3, TRAJ_CHUNK: 4, CAR_SNAPSHOT: 5, DEMAND_TICK: 6, TICK: 7, META: 200, END: 255 };

/* ------------------------------- 记录结构 ------------------------------- */
/** 道路折线：12B/顶点，position 是每个顶点的插值进度，用于流动光效 */
export const ROAD_STRIDE = 12;
export const ROAD_ATTR = { rel: { size: 2, type: 'f32' }, pos: { size: 1, type: 'f32' } };

/** 车辆快照：16B/辆 */
export const CAR_STRIDE = 16;
export const CAR_STATUS = { IDLE: 0, PICKUP: 1, ONTRIP: 2, CHARGE: 3, RESCUE: 4 };

/** 频次量化：把计数压成 u8，用于体量展示 */
export function quantize(count, max, levels = 255) {
  if (max <= 0) return 0;
  return Math.min(levels, Math.round((count / max) * levels));
}

/* ------------------------------- 写入端 ------------------------------- */
export class FrameWriter {
  /** @param {number} kind KIND.* @param {number} count 预期总记录数 @param {number[]} meta 4 个浮点元信息 */
  constructor(kind, count, meta = [0, 0, 0, 0]) {
    this.buf = new ArrayBuffer(HEADER_BYTES);
    const dv = new DataView(this.buf);
    dv.setUint32(0, MAGIC, true);
    dv.setUint16(4, VERSION, true);
    dv.setUint16(6, kind, true);
    dv.setUint32(8, count, true);
    for (let i = 0; i < 4; i++) dv.setFloat32(12 + i * 4, meta[i] || 0, true);
    this.parts = [this.buf];
    this.bytes = HEADER_BYTES;
  }

  addFrame(type, payload) {
    const h = new ArrayBuffer(FRAME_HEADER_BYTES);
    const dv = new DataView(h);
    dv.setUint8(0, type);
    dv.setUint32(1, payload.byteLength, true);
    this.parts.push(h, payload);
    this.bytes += h.byteLength + payload.byteLength;
    return this;
  }

  /** 写入一段可结构化拷贝的记录数组 */
  addRecords(type, typedArray) {
    return this.addFrame(type, typedArray.buffer.slice(typedArray.byteOffset, typedArray.byteOffset + typedArray.byteLength));
  }

  end() {
    this.addFrame(FRAME.END, new ArrayBuffer(0));
    return Buffer.concat(this.parts.map((p) => Buffer.from(p)));
  }
}

/* ------------------------------- 读取端 ------------------------------- */
/**
 * 增量帧解析器。喂进任意长度的字节块，吐出所有已完整的帧。
 * 半包会留在内部缓冲区，等下一块数据到达。
 */
export class FrameParser {
  constructor() {
    this._buf = new Uint8Array(0);
    this._header = null;
    this.frames = [];
    this.bytesIn = 0;
  }

  /** @param {Uint8Array} chunk @returns {Array<{type:number, payload:ArrayBuffer}>} 本次新产生的完整帧 */
  push(chunk) {
    this.bytesIn += chunk.byteLength;
    // 拼接并保留半包
    const merged = new Uint8Array(this._buf.length + chunk.length);
    merged.set(this._buf, 0);
    merged.set(chunk, this._buf.length);
    this._buf = merged;

    let off = 0;
    const out = [];
    if (!this._header) {
      if (this._buf.length < HEADER_BYTES) return out;
      const dv = new DataView(this._buf.buffer, this._buf.byteOffset, HEADER_BYTES);
      const magic = dv.getUint32(0, true);
      if (magic !== MAGIC) throw new Error(`数据流魔数不匹配: 0x${magic.toString(16)}`);
      this._header = {
        version: dv.getUint16(4, true),
        kind: dv.getUint16(6, true),
        count: dv.getUint32(8, true),
        meta: [0, 1, 2, 3].map((i) => dv.getFloat32(12 + i * 4, true)),
      };
      off = HEADER_BYTES;
    }
    while (this._buf.length - off >= FRAME_HEADER_BYTES) {
      const dv = new DataView(this._buf.buffer, this._buf.byteOffset + off, FRAME_HEADER_BYTES);
      const type = dv.getUint8(0);
      const len = dv.getUint32(1, true);
      if (this._buf.length - off - FRAME_HEADER_BYTES < len) break; // 半包
      const start = off + FRAME_HEADER_BYTES;
      // 拷贝成独立 ArrayBuffer，便于 transfer 给主线程（零拷贝移交）
      const payload = this._buf.buffer.slice(this._buf.byteOffset + start, this._buf.byteOffset + start + len);
      out.push({ type, payload });
      off = start + len;
    }
    this._buf = this._buf.subarray(off).slice();
    return out;
  }

  get header() { return this._header; }
  get pending() { return this._buf.length; }
}

/* --------------------------- 记录级视图（零拷贝） --------------------------- */
export function carsOf(payload) {
  const f32 = new Float32Array(payload, 0, (payload.byteLength / 4) | 0);
  const n = (payload.byteLength / CAR_STRIDE) | 0;
  return {
    n,
    lon: (i) => f32[(i * CAR_STRIDE) / 4],
    lat: (i) => f32[(i * CAR_STRIDE) / 4 + 1],
    a: (i) => f32[(i * CAR_STRIDE) / 4 + 2],
    b: (i) => f32[(i * CAR_STRIDE) / 4 + 3],
  };
}
