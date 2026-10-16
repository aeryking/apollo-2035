/**
 * 城市名标注（?showcity，默认开；测量模式默认关）
 *
 * - 位置：城市光晕正下方（放不下时换到上方），随光晕大小（随缩放变大）调整距离；
 * - 只标已「点亮」的城市：数据流到达、光晕闪亮的同时出现名字，和流式加载同步；
 * - 防重叠：按人口从大到小贪心摆放，与已放标签相交的小城市跳过（长三角、珠三角不会挤成一团）；
 * - 随光晕一起退场：缩放 ≥ 7.5 时隐藏，此时单车与路网接管画面。
 *
 * 用 BMap.Label（DOM 覆盖物，平移缩放由地图引擎负责跟随），同屏最多几十个，开销可忽略。
 */
const HIDE_ZOOM = 7.5;

export class CityLabels {
  constructor(map, cities, { max = 32 } = {}) {
    this.map = map;
    this.max = max;
    this.cities = [...cities].filter((c) => c.weight > 0).sort((a, b) => b.weight - a.weight);
    this.loaded = new Set();
    this.labels = new Map();          // id -> BMap.Label
    this.hidden = false;
    this._t = 0;
    const relayout = () => this.schedule();
    map.addEventListener('zoomend', relayout);
    map.addEventListener('moveend', relayout);
    // 运镜动画途中不一定逐级派发 zoomend，轮询一下缩放级别决定显隐（只读一个数，开销忽略）
    this._iv = setInterval(() => this._checkZoom(), 300);
  }

  markLoaded(id) {
    if (this.loaded.has(id)) return;
    this.loaded.add(id);
    this.schedule();
  }

  schedule(ms = 150) {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.layout(), ms);
  }

  _checkZoom() {
    const hide = this.map.getZoom() >= HIDE_ZOOM;
    if (hide === this.hidden) return;
    this.hidden = hide;
    if (hide) for (const l of this.labels.values()) l.hide();
    else this.layout();
  }

  _label(c) {
    let l = this.labels.get(c.id);
    if (l) return l;
    const name = c.name.replace(/市$/, '');
    const big = c.weight >= 1500;
    l = new BMap.Label(`<span class="city-label${big ? ' big' : ''}">${name}</span>`, {
      position: new BMap.Point(c.center[0], c.center[1]),
      offset: new BMap.Size(0, 10),
    });
    l.setStyle({ border: '0', background: 'transparent', padding: '0' });
    l._w = name.length * (big ? 14.5 : 13.5) + 15;  // 估算宽度（含字距与衬底内边距），用于防重叠
    this.map.addOverlay(l);
    this.labels.set(c.id, l);
    return l;
  }

  layout() {
    if (this.map.getZoom() >= HIDE_ZOOM) { this.hidden = true; for (const l of this.labels.values()) l.hide(); return; }
    this.hidden = false;
    const z = this.map.getZoom();
    // 与 glow.js 同一口径：光晕直径 = (7 + √人口 × 0.62) × 2^((z − 5) × 0.55) CSS 像素
    const scale = Math.pow(2, (z - 5) * 0.55);
    const W = innerWidth, H = innerHeight;
    const boxes = [];
    const hit = (b) => boxes.some((o) => b[0] < o[2] && o[0] < b[2] && b[1] < o[3] && o[1] < b[3]);
    const show = new Set();
    for (const c of this.cities) {
      if (show.size >= this.max) break;
      if (!this.loaded.has(c.id)) continue;
      const px = this.map.pointToPixel(new BMap.Point(c.center[0], c.center[1]));
      if (!px || px.x < -40 || px.y < -40 || px.x > W + 40 || px.y > H + 40) continue;
      const r = ((7 + Math.sqrt(Math.max(30, c.weight)) * 0.62) * scale) / 2;
      const w = this._label(c)._w;
      // 先放光晕下方；和已有标签相撞就试上方（如成都与重庆的名字挨得很近）
      const below = Math.round(r * 0.5 + 3), above = -Math.round(r * 0.5 + 21);
      let off = null;
      for (const o of [below, above]) {
        const box = [px.x - w / 2 - 3, px.y + o - 2, px.x + w / 2 + 3, px.y + o + 19];
        if (!hit(box)) { boxes.push(box); off = o; break; }
      }
      if (off === null) continue;
      this._label(c).setOffset(new BMap.Size(0, off));
      show.add(c.id);
    }
    for (const [id, l] of this.labels) (show.has(id) ? l.show() : l.hide());
  }
}
