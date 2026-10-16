/**
 * 路网流式加载：Worker 用 fetch ReadableStream 逐块读取路网数据块，
 * 解析出一个城市的线段帧就零拷贝转移给主线程，主线程排队按帧预算上显存。
 *
 * 调度策略：按「视野中心距离 / 城市重要度」排序数据块，看得见的地方先加载。
 * 视野变化时可调用 prioritize() 重排尚未开始的块。
 */
import { FRAME } from './binary.js';

export class LineFeed {
  constructor({ layer, packs, cities, baseUrl = '/data/', concurrency = 2, onEvent }) {
    this.layer = layer;
    this.packs = packs.slice();
    this.byId = new Map(cities.map((c) => [c.id, c]));
    this.baseUrl = baseUrl;
    this.concurrency = concurrency;
    this.onEvent = onEvent || (() => {});
    this.bytes = 0;
    this.cities = 0;
    this.segments = 0;
    this.done = 0;
    this.t0 = 0;
    this.worker = new Worker(new URL('./stream.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => this._recv(ev.data);
    this._pendingId = null;
    this._active = 0;
  }

  /** 按视野中心重排未开始的数据块 */
  prioritize(center) {
    if (!center) return;
    const [cx, cy] = center;
    const score = (pk) => {
      let best = Infinity;
      for (const id of pk.cities) {
        const c = this.byId.get(id);
        if (!c) continue;
        const d = Math.hypot(c.center[0] - cx, c.center[1] - cy) / Math.max(0.05, c.weight / 100);
        if (d < best) best = d;
      }
      return best;
    };
    this.packs.sort((a, b) => score(a) - score(b));
  }

  start() {
    this.t0 = performance.now();
    for (let i = 0; i < this.concurrency; i++) this._next();
    return this;
  }

  _next() {
    const pk = this.packs.shift();
    if (!pk) {
      if (this._active === 0 && !this._finished) {
        this._finished = true;
        this.onEvent({ t: 'linesDone', cities: this.cities, segments: this.segments, bytes: this.bytes, ms: performance.now() - this.t0 });
      }
      return;
    }
    this._active++;
    this.worker.postMessage({ cmd: 'fetch', url: this.baseUrl + pk.file, kind: 1, token: pk.file });
  }

  _recv(m) {
    if (m.t === 'progress') {
      // 进度由 frame 内累计
    } else if (m.t === 'frame') {
      this.bytes += m.payload.byteLength + 5;
      this.tLastByte = performance.now();     // 加载吞吐按「实际传输时长」计
      if (m.type === FRAME.META) {
        this._pendingId = new TextDecoder().decode(m.payload).split('|')[0];
      } else if (m.type === FRAME.ROAD_CHUNK) {
        const dv = new DataView(m.payload);
        const nSeg = dv.getUint32(0, true);
        // 前 32 字节是城市头，之后是线段数组（已是图层绝对坐标）
        const segs = new Float32Array(m.payload, 32, nSeg * 8);
        this.layer.pushSegments(segs);
        if (this._pendingId !== this._lastCity) { this.cities++; this._lastCity = this._pendingId; }
        this.segments += nSeg;
        this.onEvent({ t: 'line', city: this._pendingId, segs: nSeg, ms: performance.now() - this.t0 });
      }
    } else if (m.t === 'done') {
      this._active--;
      this._next();
    } else if (m.t === 'error') {
      console.error('[lines]', m.message);
      this._active--;
      this._next();
    }
  }

  dispose() { this.worker.terminate(); }
}
