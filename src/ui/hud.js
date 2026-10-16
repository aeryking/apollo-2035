/** HUD：实时指标、性能数字与帧率曲线 */
const $ = (id) => document.getElementById(id);
const SPARK_W = 214;   // 与 style.css 中 #hud-perf 的 min-width、.spark 的宽高保持一致
const SPARK_H = 30;

export class Hud {
  constructor() {
    this.fpsHistory = new Float32Array(120);
    this.fpsIdx = 0;
    this.frames = 0;
    this.lastT = performance.now();
    this.fps = 0;
    this.minFps = Infinity;
    this.jank = 0;          // 掉帧（>32ms）次数
    this.frameMs = 0;
    this.canvas = $('p-spark');
    this.sparkCtx = this.canvas?.getContext('2d');
    this.resizeSpark();
  }

  /**
   * 帧率曲线画布用固定尺寸（与 CSS 中 .spark 一致），不读取页面布局。
   * 实测：页面加载时调用 getBoundingClientRect() 会在百度地图大量插入 DOM 的当口
   * 触发强制同步布局，主线程被卡住约 0.7 s。
   */
  resizeSpark() {
    const c = this.canvas;
    if (!c) return;
    c.width = Math.round(SPARK_W * devicePixelRatio);
    c.height = Math.round(SPARK_H * devicePixelRatio);
  }

  /** 每帧调用，统计真实帧率 */
  frame(now = performance.now()) {
    const dt = now - this.lastT;
    this.lastT = now;
    this.frameMs = dt;
    this.frames++;
    if (dt > 32) this.jank++;
    if (now - (this._fpsT || 0) > 500) {
      this._fpsT = now;
      this.fps = (this.frames * 1000) / (now - (this._sampleT || now - 500));
      this.frames = 0;
      this._sampleT = now;
      this.minFps = Math.min(this.minFps, this.fps);
      this.fpsHistory[this.fpsIdx = (this.fpsIdx + 1) % this.fpsHistory.length] = this.fps;
      this.drawSpark();
    }
  }

  drawSpark() {
    const ctx = this.sparkCtx;
    if (!ctx) return;
    const { width: w, height: h } = this.canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(120,160,220,.25)';
    ctx.lineWidth = devicePixelRatio;
    ctx.beginPath(); ctx.moveTo(0, h * 0.33); ctx.lineTo(w, h * 0.33); ctx.stroke();
    ctx.strokeStyle = '#5ce08a';
    ctx.lineWidth = 1.5 * devicePixelRatio;
    ctx.beginPath();
    const hist = this.fpsHistory;
    for (let i = 0; i < hist.length; i++) {
      const v = hist[(i + this.fpsIdx + 1) % hist.length];
      const x = (i / (hist.length - 1)) * w;
      const y = h - Math.min(1, v / 70) * h;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  setText(id, v) { const e = $(id); if (e) e.textContent = v; }

  /** 左上角状态：接入中 / 实时运营中（车队就绪后由调用方切换） */
  setStatus(text) {
    this.setText('b-status', text);
  }

  update(d = {}) {
    this.setText('p-fps', this.fps ? this.fps.toFixed(0) : '--');
    const fpsEl = $('p-fps');
    if (fpsEl) fpsEl.className = this.fps >= 55 ? '' : 'warn';
    this.setText('p-frame', `${this.frameMs.toFixed(1)} ms`);
    this.setText('p-upload', d.uploadMs != null ? `${d.uploadMs.toFixed(1)} ms` : '0.0 ms');
    this.setText('p-gpu', d.gpuMs != null ? `${d.gpuMs.toFixed(1)} ms` : '-- ms');
    this.setText('p-dc', String(d.draws ?? 0));
    this.setText('p-zoom', d.zoom != null ? d.zoom.toFixed(1) : '--');
    if (d.cars != null) this.setText('m-cars', d.cars.toLocaleString());
    if (d.features != null) this.setText('m-features', d.features.toLocaleString());
    if (d.bytes != null) this.setText('m-bytes', `${(d.bytes / 1048576).toFixed(1)} MB`);
    if (d.rate != null) this.setText('m-rate', `${d.rate.toFixed(1)} MB/s`);
  }
}
