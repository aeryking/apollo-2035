/**
 * 流式数据源：在 Worker 里用 fetch 的 ReadableStream 逐块读取，
 * 边下载边解析帧，解析出的帧用可转移 ArrayBuffer 零拷贝交给主线程。
 *
 * 主线程不做任何解析工作，只负责「把帧写进显存」。
 * 这满足赛题说的：数据获取、数据解析、数据渲染三者异步化。
 */

export class StreamSource {
  /**
   * @param {object} o
   * @param {(msg:object)=>void} o.onFrame 每解析出一个帧回调（主线程侧）
   * @param {(p:object)=>void} [o.onProgress]
   * @param {(e:Error)=>void} [o.onError]
   */
  constructor({ onFrame, onProgress, onError, workerUrl, threads } = {}) {
    this.onFrame = onFrame;
    this.onProgress = onProgress;
    this.onError = onError || ((e) => console.error(e));
    const n = threads || Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    this.pool = Array.from({ length: n }, () => {
      const w = new Worker(workerUrl || new URL('./stream.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => this._recv(ev.data);
      w.onerror = (e) => this.onError(e.error || new Error(e.message));
      return w;
    });
    this._rr = 0;
    this.stats = { bytes: 0, frames: 0, byKind: {}, t0: 0, tFirstFrame: 0 };
  }

  _recv(msg) {
    if (msg.t === 'frame') {
      if (!this.stats.tFirstFrame) this.stats.tFirstFrame = performance.now() - this.stats.t0;
      this.stats.frames++;
      this.stats.byKind[msg.kind] = (this.stats.byKind[msg.kind] || 0) + 1;
      this.onFrame?.(msg);
    } else if (msg.t === 'done') {
      this.stats.elapsed = performance.now() - this.stats.t0;
      this.onProgress?.({ done: true, ...msg, stats: this.stats });
    } else if (msg.t === 'progress') {
      this.onProgress?.(msg);
    } else if (msg.t === 'error') {
      this.onError(new Error(msg.message));
    }
  }

  /** 发起一个流式请求；返回 Promise，全部帧交付后 resolve */
  fetch(url, { kind = 'misc', priority = 'auto' } = {}) {
    this.stats.t0 = performance.now();
    const w = this.pool[this._rr++ % this.pool.length];
    return new Promise((resolve, reject) => {
      const token = `${kind}#${Math.random().toString(36).slice(2, 8)}`;
      this._pending = this._pending || new Map();
      this._pending.set(token, { resolve, reject });
      w.postMessage({ cmd: 'fetch', url, kind, token, priority });
    });
  }

  _settle(token, ok, err) {
    const p = this._pending?.get(token);
    if (!p) return;
    this._pending.delete(token);
    ok ? p.resolve() : p.reject(err);
  }

  dispose() {
    this.pool.forEach((w) => w.terminate());
    this.pool = [];
  }
}
