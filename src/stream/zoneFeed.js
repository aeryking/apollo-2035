/**
 * 区域面流式加载：把 zones.ndjson 交给 Worker 解析+三角化，
 * 算好一批就传回一批，主线程直接增量上显存。
 */
export class ZoneFeed {
  constructor({ layer, url = '/data/zones.ndjson', coord = 'gcj02', onEvent }) {
    this.layer = layer;
    this.url = url;
    this.coord = coord;
    this.onEvent = onEvent || (() => {});
    this.worker = null;
    this.stats = { fill: 0, lines: 0, features: 0 };
  }

  start() {
    const w = new Worker(new URL('./zone.worker.js', import.meta.url), { type: 'module' });
    this.worker = w;
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.t === 'fill') {
        this.layer.pushFill(new Float32Array(m.data));
        this.stats.fill += m.count;
      } else if (m.t === 'line') {
        this.layer.pushOutline(new Float32Array(m.data));
        this.stats.lines += m.count;
      } else if (m.t === 'done') {
        this.stats.features = m.features;
        this.onEvent({ ...m, ...this.stats, t: 'zonesDone' });
      } else if (m.t === 'error') {
        console.error('[zone]', m.message);
      }
    };
    w.onerror = (e) => console.error('[zone worker]', e.message);
    w.postMessage({ cmd: 'zones', url: this.url, coord: this.coord });
    return this;
  }

  dispose() { this.worker?.terminate(); }
}
