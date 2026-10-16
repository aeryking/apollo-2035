/**
 * 车队调度：把全国车辆按城市权重分给若干仿真 Worker。
 *
 *  - 城市按权重做贪心装箱，让各 Worker 负载接近；
 *  - 每个 Worker 在图层里独占一段实例区间（分片），各自独立换页；
 *  - Worker 每加载完一个城市就上报该城的实例区间与包围盒，图层据此做视锥剔除。
 *
 * 主线程在这里只做转发，不碰任何逐车数据。
 */
export class Fleet {
  constructor({ layer, cities, packs, total, workers, wasm = true, baseUrl = '/data/', onEvent }) {
    this.packs = packs;
    this.wasm = wasm;
    this.layer = layer;
    this.cities = cities.filter((c) => c.weight > 0);
    this.total = total;
    const hc = navigator.hardwareConcurrency || 4;
    this.workerCount = Math.max(1, Math.min(workers || Math.max(2, hc - 2), this.cities.length));
    this.baseUrl = baseUrl;
    this.onEvent = onEvent || (() => {});
    this.spawned = 0;
    this.loadedCities = 0;
    this.loadedBytes = 0;
    this.t0 = performance.now();
    this._spawn();
  }

  _spawn() {
    // 以「数据块」为单位做贪心装箱：权重大的块先分配给最空闲的 Worker。
    // 每个 Worker 只下载、解析自己负责的块，彼此不重复。
    const byId = new Map(this.cities.map((c) => [c.id, c]));
    const packs = [...this.packs].sort((a, b) => b.weight - a.weight);
    const buckets = Array.from({ length: this.workerCount }, () => ({ packs: [], cities: [], load: 0 }));
    for (const pk of packs) {
      let mi = 0;
      for (let i = 1; i < buckets.length; i++) if (buckets[i].load < buckets[mi].load) mi = i;
      buckets[mi].packs.push(pk);
      for (const id of pk.cities) if (byId.has(id)) buckets[mi].cities.push(byId.get(id));
      buckets[mi].load += pk.weight;
    }
    const totalLoad = buckets.reduce((s, b) => s + b.load, 0) || 1;

    let assigned = 0;
    this.workers = buckets.map((b, wi) => {
      const count = wi === buckets.length - 1 ? this.total - assigned : Math.round((b.load / totalLoad) * this.total);
      assigned += count;
      // 城市内配额：按权重比例，余数补给大城市
      const quota = b.cities.map((c) => Math.floor((c.weight / Math.max(1, b.load)) * count));
      let rest = count - quota.reduce((s, q) => s + q, 0);
      for (let i = 0; rest > 0 && quota.length; i = (i + 1) % quota.length, rest--) quota[i]++;

      const partIndex = this.layer.parts.length;
      this.layer.addPart({ offset: 0, count });

      const ranges = [];
      const w = new Worker(new URL('./vehicles.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => this._onMessage(wi, partIndex, ranges, ev.data);
      w.onerror = (e) => console.error('[fleet worker]', e.message || e);
      w.postMessage({
        cmd: 'config',
        workerIndex: wi,
        workerCount: buckets.length,
        n: count,
        packs: b.packs,
        cityIds: b.cities.map((c) => c.id),
        quota,
        baseUrl: this.baseUrl,
        wasm: this.wasm,
        wasmUrl: '/wasm/a35sim.wasm',
      });
      return { w, count, ranges, cities: b.cities, packs: b.packs };
    });
  }

  _onMessage(wi, partIndex, ranges, msg) {
    switch (msg.t) {
      case 'bytes':
        this.loadedBytes += msg.n;
        this.tLastByte = performance.now();   // 加载吞吐按「实际传输时长」计
        break;
      case 'city': {
        ranges.push(msg.range);
        this.loadedCities++;
        this.onEvent({ t: 'city', worker: wi, id: msg.id, real: msg.real, routes: msg.routes, spawned: msg.spawned });
        break;
      }
      case 'snap': {
        // 记录每个 Worker 最近一次推进 + 打包耗时（ms/秒，即单核占用的千分比）
        (this._step ||= {})[wi] = (msg.stepMs || 0) + (msg.packMs || 0);
        // 区间表拷一份交给图层：上传完成换页时才生效，保证与数据一致
        this.layer.pushSnapshot(partIndex, msg.data, ranges.slice());
        this.tod = msg.tod;
        this.onEvent({ t: 'snap', worker: wi, n: msg.n, stepMs: msg.stepMs, tod: msg.tod });
        break;
      }
      case 'ready':
        this.kernel = msg.wasm ? 'wasm' : 'js';
        this.onEvent({ t: 'ready', worker: wi, n: msg.n, cities: msg.cities, wasm: msg.wasm });
        break;
      case 'corridor':
      case 'ambulance':
        this.onEvent({ ...msg, worker: wi });
        break;
      case 'warn':
        console.warn('[fleet]', msg.msg);
        break;
      default:
    }
  }

  /** 各 Worker 平均每秒仿真耗时（ms） */
  avgStepMs() {
    const v = Object.values(this._step || {});
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  }

  /** 已上显存的车辆数 */
  get liveCount() {
    return this.layer.parts.reduce((s, p) => s + p.filled, 0);
  }

  /** 生命通道开关：只有负责该城市的 Worker 会真正响应；kind = ambulance（120）/ fire（119 消防车队） */
  corridor(on, cityId = 'beijing', kind = 'ambulance') {
    for (const x of this.workers || []) x.w.postMessage({ cmd: 'corridor', on, cityId, kind });
  }

  setSim(o) {
    for (const x of this.workers || []) x.w.postMessage({ cmd: 'sim', ...o });
  }

  dispose() {
    for (const x of this.workers || []) x.w.terminate();
  }
}
