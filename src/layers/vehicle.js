/**
 * 车辆图层：百万级实例化绘制 + GPU 端快照插值
 *
 * 四个关键设计：
 *  1) 仿真每秒产出一次位置快照（对应真实车队的定位上报节拍），画面却是连续 60 fps ——
 *     顶点着色器在「上一秒的缓冲」和「下一秒的缓冲」之间按时间混合，CPU 不参与逐帧计算。
 *  2) 每个 Worker 分片拥有自己的一组三缓冲，彼此独立换页，互不等待。
 *  3) 上传按帧时间预算切块（默认 2.5 ms/帧），几百万辆车的快照也不会让帧率掉下来。
 *  4) 远景用点精灵，近景切成实例化四边形画车身胶囊；并按城市包围盒做视锥剔除，
 *     不可见的城市直接跳过整个区间，不用把顶点喂给 GPU。
 *
 * 快照记录 16 字节：
 *   float32 x, y, angle  |  u8 speed  u8 state  u8 born  u8 len
 */
import { BaseLayer } from './base.js';
import { program, GLX } from '../core/gl.js';

export const SNAP_STRIDE = 16;

const STATE_COLORS = `
const vec3 C_IDLE   = vec3(0.26, 0.74, 1.00);
const vec3 C_PICKUP = vec3(0.34, 0.98, 0.60);
const vec3 C_TRIP   = vec3(1.00, 0.76, 0.28);
const vec3 C_CHARGE = vec3(0.66, 0.44, 1.00);
const vec3 C_RESCUE = vec3(1.00, 1.00, 1.00);   // 让行：亮白色，压在红色生命通道上依然醒目
vec3 stateColor(float s) {
  if (s < 0.5) return C_IDLE;
  if (s < 1.5) return C_PICKUP;
  if (s < 2.5) return C_TRIP;
  if (s < 3.5) return C_CHARGE;
  return C_RESCUE;
}`;

/* ---------------- 远景：点精灵（一个顶点一辆车，最省） ---------------- */
const POINT_VS = `
precision highp float;
attribute vec4 a_prev;
attribute vec4 a_next;
attribute vec4 a_pack;      // speed, state, born, len  （按 0..1 归一化）
uniform mat4 u_mvpMatrix;
uniform float u_mix;
uniform float u_pxSize;
uniform float u_pixelRatio;
uniform float u_alpha;
varying vec3 v_color;
varying float v_alpha;
varying float v_born;
${STATE_COLORS}
void main() {
  float born = step(0.5 / 255.0, a_pack.z);
  vec2 pos = mix(a_prev.xy, a_next.xy, mix(u_mix, 1.0, born));
  float spd = a_pack.x * 255.0 / 80.0;
  gl_Position = u_mvpMatrix * vec4(pos, 0.0, 1.0);
  // 空驶的暗、载客的亮，速度越快越亮
  float lum = 0.6 + 0.5 * clamp(spd, 0.0, 1.0);
  v_color = stateColor(a_pack.y * 255.0) * lum;
  v_alpha = u_alpha;
  gl_PointSize = u_pxSize * u_pixelRatio;
  v_born = born;
}`;

const POINT_FS = `
precision mediump float;
varying vec3 v_color;
varying float v_alpha;
void main() {
  // 注意：不用 discard、不用 exp。
  // 在 Apple 等分块延迟渲染（TBDR）GPU 上，discard 会让整块 tile 失去隐藏面消除等优化；
  // 远景下几十万个点叠在少数像素上，片元着色器的每条指令都会被放大成千上万倍。
  // 用二次多项式衰减近似「亮核 + 辉光」，圆外 alpha 自然为 0，交给混合处理。
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;               // 0（中心）→ 1（内切圆边缘）
  float t = max(0.0, 1.0 - r2);
  float core = t * t * t;                   // 亮核
  float halo = t * 0.45;                    // 辉光
  gl_FragColor = vec4(v_color * (0.7 + core * 1.6), (core + halo) * v_alpha);
}`;

/* ---------------- 近景：实例化四边形（有朝向的车身胶囊） ---------------- */
const QUAD_VS = `
precision highp float;
attribute vec2 a_corner;
attribute vec4 a_prev;
attribute vec4 a_next;
attribute vec4 a_pack;
uniform mat4 u_mvpMatrix;
uniform float u_mix;
uniform float u_mpp;         // 每像素多少图层单位
uniform float u_pixelRatio;
uniform float u_alpha;
uniform float u_sizeGain;
uniform float u_zoom;
varying vec3 v_color;
varying float v_alpha;
varying vec2 v_local;
${STATE_COLORS}
void main() {
  float born = step(0.5 / 255.0, a_pack.z);
  vec2 pos = mix(a_prev.xy, a_next.xy, mix(u_mix, 1.0, born));
  float lenM = max(a_pack.w * 2.0 * 255.0, 4.0) * u_sizeGain;
  float widM = lenM * 0.5;
  float ang = a_next.z;
  vec2 dir = vec2(cos(ang), sin(ang));
  vec2 perp = vec2(-dir.y, dir.x);
  // 车身按真实米数换算（BD09MC 单位约为米的 1.25 倍）；
  // 同时保证屏幕上至少 10×4.5 像素，否则 z15 时一辆 6 米的车还不到 1 像素
  vec2 realHalf = vec2(lenM, widM) * 1.25 * 0.5;
  // 近景最小尺寸随缩放渐大：z13.5 时 6×2.6 px，z16 以上 10×4.5 px
  float zk = clamp((u_zoom - 13.5) / 2.5, 0.0, 1.0);
  vec2 minHalf = mix(vec2(3.0, 1.3), vec2(5.0, 2.25), zk) * u_mpp;
  vec2 halfM = max(realHalf, minHalf);
  vec2 off = dir * (a_corner.x * 2.0 * halfM.x) + perp * (a_corner.y * 2.0 * halfM.y);
  gl_Position = u_mvpMatrix * vec4(pos + off, 0.0, 1.0);
  v_color = stateColor(a_pack.y * 255.0) * (0.7 + 0.5 * clamp(a_pack.x * 255.0 / 80.0, 0.0, 1.0));
  v_local = a_corner;
  v_alpha = u_alpha;
}`;

const QUAD_FS = `
precision mediump float;
varying vec3 v_color;
varying float v_alpha;
varying vec2 v_local;
void main() {
  vec2 p = abs(v_local) * 2.0;
  float rad = 0.42;
  vec2 q = p - vec2(1.0 - rad);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
  float body = smoothstep(0.30, -0.30, d);
  float glow = exp(-max(d, 0.0) * 3.0) * 0.5;
  float a = (body * 0.95 + glow) * v_alpha;
  if (a < 0.012) discard;
  gl_FragColor = vec4(v_color * (1.0 + glow), a);
}`;

export class VehicleLayer extends BaseLayer {
  constructor(opts = {}) {
    super({ zIndex: 20, blend: 'additive', ...opts });
    this.capacity = opts.capacity || 1_000_000;
    this.parts = [];
    this.alpha = opts.alpha ?? 0.95;
    this.uploadBudgetMs = opts.uploadBudgetMs ?? 2.5;
    this.mix = 0;
    this.culling = opts.culling !== false;
    this.orphan = opts.orphan ?? false;
    this._uploadAcc = 0;      // 每秒累计上传字节 / 耗时（HUD 与测试报告用）
    this._uploadMsAcc = 0;
    this._zoomSplit = opts.zoomSplit ?? 13.5;   // 低于此缩放用点精灵（一个顶点一辆车）
    this.visibleCount = 0;
    this.totalCount = 0;
  }

  /** 注册一个 Worker 分片 */
  addPart({ offset, count }) {
    const part = {
      offset, count, filled: 0,
      bufs: [], cur: 0, mixStart: 0, period: 1000,
      job: null, ranges: [], pendingRanges: [],
    };
    this.parts.push(part);
    return part;
  }

  /** 某个分片收到新快照：排队等上传 */
  pushSnapshot(partIndex, data, ranges) {
    const p = this.parts[partIndex];
    if (!p) return;
    p.job = { data: new Float32Array(data), cursor: 0 };
    p.pendingRanges = ranges || [];
  }

  onInit(gl, map) {
    this.glx = new GLX(gl);
    this.pointProg = program(gl, POINT_VS, POINT_FS);
    this.quadProg = program(gl, QUAD_VS, QUAD_FS);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), gl.STATIC_DRAW);
    this.vramBytes = 0;
  }

  /** 分片的三缓冲按需创建（分片可能晚于 GL 就绪才注册） */
  _ensureBuffers(gl, p) {
    if (p.bufs.length) return;
    const t0 = performance.now();
    const bytes = Math.max(16, p.count * SNAP_STRIDE);
    for (let i = 0; i < 3; i++) {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW);
      p.bufs.push(b);
    }
    this.vramBytes += bytes * 3;
    this.stats.allocMs = (this.stats.allocMs || 0) + performance.now() - t0;
  }

  /** 主线程每帧：先按预算上传，再绘制 */
  onFrame(gl, ctx) {
    const t0 = performance.now();
    this._upload(gl, t0);
    this.stats.uploadMs = performance.now() - t0;
    // GPU 计时（EXT_disjoint_timer_query）：测本图层绘制在 GPU 上的真实耗时
    const timing = this.glx.timer && this.gpuTiming !== false;
    if (timing) this.glx.beginTimer();
    this._draw(gl, ctx);
    if (timing) {
      this.glx.endTimer();
      this.stats.gpuMs = this.glx.pollTimer();
    }
  }

  /**
   * 分片独立换页的上传。
   * 上传目标是「不可见的那一块」，所以上传过程中画面用的是上一组完整数据，不会出现撕裂。
   */
  _upload(gl, frameT0) {
    let uploaded = 0;
    for (const p of this.parts) {
      const job = p.job;
      if (!job) continue;
      this._ensureBuffers(gl, p);
      const total = job.data.length / 4;              // 车辆数（16 B / 4 B）
      if (!job.targets) {
        const upIdx = (p.cur + 1) % 3;
        // 首个快照两块都写，避免「上一帧」是全零导致车辆从原点飞入
        job.targets = p.filled === 0 ? [upIdx, (upIdx + 2) % 3] : [upIdx];
        job.ti = 0;
        job.cursor = 0;
        job.upIdx = upIdx;
      }
      while (job.ti < job.targets.length) {
        const buf = p.bufs[job.targets[job.ti]];
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        if (job.cursor === 0 && this.orphan) {
          // 缓冲区孤立（可选）：先 bufferData 换一块新存储，驱动无需等待 GPU 读完旧数据。
          // 三缓冲下被写入的那块已经约 1 秒没被 GPU 读过，理论上不需要；保留开关做对照测试。
          gl.bufferData(gl.ARRAY_BUFFER, Math.max(16, p.count * SNAP_STRIDE), gl.DYNAMIC_DRAW);
        }
        while (job.cursor < total) {
          const chunk = Math.min(16384, total - job.cursor);
          const src = job.data.subarray(job.cursor * 4, (job.cursor + chunk) * 4);
          const tc = performance.now();
          gl.bufferSubData(gl.ARRAY_BUFFER, job.cursor * SNAP_STRIDE, src);
          const dt = performance.now() - tc;
          if (dt > (this.stats.maxCallMs || 0)) { this.stats.maxCallMs = dt; this.stats.maxCallBytes = src.byteLength; }
          job.cursor += chunk;
          uploaded += chunk * SNAP_STRIDE;
          if (performance.now() - frameT0 > this.uploadBudgetMs) break;
        }
        if (job.cursor < total) break;               // 预算用完，下一帧继续
        job.ti++;
        job.cursor = 0;
      }
      if (job.ti >= job.targets.length) {
        p.filled = total;
        p.cur = job.upIdx;                           // 换页
        this.stats.swaps = (this.stats.swaps || 0) + 1;
        const now = performance.now();
        p.period = p._lastSwap ? Math.min(2000, Math.max(250, now - p._lastSwap)) : 1000;
        p._lastSwap = now;
        p.mixStart = now;
        p.ranges = p.pendingRanges;
        p.job = null;
      }
      if (performance.now() - frameT0 > this.uploadBudgetMs) break;
    }
    this.stats.uploadBytes = uploaded;
    this._uploadAcc += uploaded;
    this.stats.totalUploadBytes = (this.stats.totalUploadBytes || 0) + uploaded;   // 累计，供采样窗口求平均
    this._uploadMsAcc += performance.now() - frameT0;
    const now = performance.now();
    if (now - (this._uploadWin || 0) > 1000) {
      this.stats.uploadMBps = this._uploadAcc / 1048576 / ((now - (this._uploadWin || now - 1000)) / 1000);
      this.stats.uploadMsPerSec = this._uploadMsAcc;
      this._uploadAcc = 0; this._uploadMsAcc = 0; this._uploadWin = now;
    }
  }

  _draw(gl, ctx) {
    const zoom = ctx.getZoom();
    const wide = zoom < this._zoomSplit;
    // 远景用叠加混合（密集处自然发光），近景用普通混合（车身清晰）。
    // 混合方式走官方 renderState，下一帧生效。
    const blend = wide ? 'additive' : 'normal';
    if (blend !== this._blend) { this._blend = blend; this.setBlend(blend); }
    const glx = this.glx;
    const prevBufIdx = (this.parts[0]?.cur ?? 0);
    // 插值系数：本 Worker 分片各自计时
    let drawn = 0, prims = 0;
    const view = this._viewBounds(ctx);

    for (const p of this.parts) {
      if (!p.filled) continue;
      const period = Math.max(200, p.period);
      const mix = Math.min(1, (performance.now() - p.mixStart) / period);
      const prev = p.bufs[(p.cur + 2) % 3];
      const next = p.bufs[p.cur];

      const g = wide ? this.pointProg : this.quadProg;
      gl.useProgram(g.p);
      gl.uniformMatrix4fv(g.u.u_mvpMatrix, false, ctx.getMVPMatrix());
      gl.uniform1f(g.u.u_mix, mix);
      gl.uniform1f(g.u.u_pixelRatio, ctx.getPixelRatio());
      gl.uniform1f(g.u.u_alpha, this.alpha * this._alphaFor(zoom));
      gl.uniform1f(g.u.u_sizeGain, wide ? 1 : 1);
      if (wide) gl.uniform1f(g.u.u_pxSize, this._pointSize(ctx));
      else {
        gl.uniform1f(g.u.u_mpp, ctx.getUnitsPerPixel());
        gl.uniform1f(g.u.u_zoom, zoom);
      }

      const strideB = SNAP_STRIDE;
      // 屏幕密度自适应 LOD（只用于远景点精灵）：
      // 全国视角下成千上万辆车落在同一像素上，逐个混合在分块渲染 GPU 上代价极高（实测 100 万车 27 ms/帧）。
      // 这里用「属性步长」每 k 辆取 1 辆绘制，亮度乘 k 补偿 —— 画面几乎无差别，GPU 工作量降为 1/k。
      // 步长受 WebGL1 上限 255 字节约束（16 B × k ≤ 255 → k ≤ 15）。
      // 用全局车辆总数判断密度（单个分片可能只有几万辆）
      const lodK = wide ? this._lodFor(zoom, this.totalCount || p.filled) : 1;
      const strideEff = strideB * lodK;
      // WebGL1 没有 baseInstance：区间起点要通过属性指针的字节偏移实现
      const bindAttrs = (firstCar, div) => {
        const base = firstCar * strideB;
        const sB = div ? strideB : strideEff;
        gl.bindBuffer(gl.ARRAY_BUFFER, prev);
        gl.enableVertexAttribArray(g.a.a_prev);
        gl.vertexAttribPointer(g.a.a_prev, 4, gl.FLOAT, false, sB, base);
        glx.divisor(g.a.a_prev, div);
        gl.bindBuffer(gl.ARRAY_BUFFER, next);
        gl.enableVertexAttribArray(g.a.a_next);
        gl.vertexAttribPointer(g.a.a_next, 4, gl.FLOAT, false, sB, base);
        glx.divisor(g.a.a_next, div);
        gl.enableVertexAttribArray(g.a.a_pack);
        gl.vertexAttribPointer(g.a.a_pack, 4, gl.UNSIGNED_BYTE, true, sB, base + 12);
        glx.divisor(g.a.a_pack, div);
      };
      if (!wide) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
        gl.enableVertexAttribArray(g.a.a_corner);
        gl.vertexAttribPointer(g.a.a_corner, 2, gl.FLOAT, false, 0, 0);
        glx.divisor(g.a.a_corner, 0);
      }

      // 按城市区间绘制：视锥剔除 + 相邻区间合并
      const segs = this._mergeRanges(p.ranges, view, p);
      if (wide) {
        // 远景：一个顶点一辆车，非实例化点精灵
        bindAttrs(0, 0);
        // 亮度补偿用 k^0.25 而非 √k：远景已有城市光晕，单车点只做质感，过亮会叠加成一片白
        // 抽稀后不做亮度补偿：远景已有城市光晕，单车点过亮会叠加成一片白
        gl.uniform1f(g.u.u_alpha, Math.min(1, this.alpha * this._alphaFor(zoom)));
        for (const seg of segs) {
          const first = Math.ceil(seg.start / lodK);
          const count = Math.floor((seg.start + seg.count) / lodK) - first;
          if (count <= 0) continue;
          gl.drawArrays(gl.POINTS, first, count);
          drawn++; prims += count;
        }
        this.stats.lodK = lodK;
      } else {
        // 近景：实例化四边形，区间起点用属性偏移表达
        for (const seg of segs) {
          if (seg.count <= 0) continue;
          bindAttrs(seg.start, 1);
          glx.drawInstanced(gl.TRIANGLES, seg.count, 6, 0);
          drawn++; prims += seg.count;
        }
      }
      for (const l of [g.a.a_corner, g.a.a_prev, g.a.a_next, g.a.a_pack]) {
        if (l === undefined || l < 0) continue;
        glx.divisor(l, 0);
        gl.disableVertexAttribArray(l);
      }
    }
    this.stats.draws = drawn;
    this.stats.prims = prims;
    this.visibleCount = prims;
    this.totalCount = this.parts.reduce((s, p) => s + p.filled, 0);
  }

  /**
   * 视口对应的图层坐标范围（留余量），用于剔除不可见的城市。
   * 直接用图层自带的地图系投影，保证与顶点着色器使用的坐标完全一致。
   */
  _viewBounds(ctx) {
    if (!this.culling) return null;
    // map.getBounds() 在 JSAPI 内部会做大量坐标转换（实测每帧调用占主线程 7%），
    // 这里按「矩阵是否变化」缓存：相机不动就不重算。
    const m = ctx.getMVPMatrix();
    const key = m[0] + m[5] * 3 + m[12] * 7 + m[13] * 11;
    if (this._vbKey === key && this._vb !== undefined) return this._vb;
    const now = performance.now();
    // 相机连续运动时最多 8 Hz 重算一次，剔除结果略滞后无妨（已留 25% 余量）
    if (this._vb !== undefined && now - (this._vbT || 0) < 125) return this._vb;
    this._vbKey = key;
    this._vbT = now;
    const proj = ctx.layer?.projectToLayer?.bind(ctx.layer);
    if (!proj) return (this._vb = null);
    try {
      const b = this.map.getBounds();
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      if (ne.lng - sw.lng > 300) return (this._vb = null);
      const a = proj([sw.lng, sw.lat]);
      const c = proj([ne.lng, ne.lat]);
      const pad = 0.25 * Math.max(c[0] - a[0], c[1] - a[1]);
      return (this._vb = [a[0] - pad, a[1] - pad, c[0] + pad, c[1] + pad]);
    } catch {
      return (this._vb = null);
    }
  }

  /** 合并可见区间，减少 draw call */
  _mergeRanges(ranges, view, part) {
    if (!ranges || !ranges.length) return [{ start: 0, count: part.filled }];
    const out = [];
    let cur = null;
    for (const r of ranges) {
      if (!r || !r.count) continue;
      if (view && r.bbox) {
        const [x0, y0, x1, y1] = r.bbox;
        const pad = 0.2 * Math.max(x1 - x0, y1 - y0) + 2000;
        if (x1 + pad < view[0] || x0 - pad > view[2] || y1 + pad < view[1] || y0 - pad > view[3]) continue;
      }
      const start = r.start, end = Math.min(r.start + r.count, part.filled);
      if (end <= start) continue;
      if (cur && start - (cur.start + cur.count) < 20000) {
        cur.count = end - cur.start;
      } else {
        if (cur) out.push(cur);
        cur = { start, count: end - start };
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** 点大小：随缩放平滑变化，远景是细密光点，近景逐渐变大 */
  _pointSize(ctx) {
    const z = ctx.getZoom();
    // 远景点更小：像素填充量与点径平方成正比，1.4 px 比 1.9 px 少约一半片元
    return Math.max(1.4, Math.min(5.0, 1.4 + (z - 5) * 0.32));
  }

  /** LOD 系数：缩放越小、数量越多，抽稀越狠 */
  _lodFor(zoom, n) {
    if (this.opts.lod === false || n < 200_000) return 1;
    // 以「绘制 ≤ 约 10 万个远景点」为目标选取步长，WebGL1 步长上限 15（16 B × 15 = 240 B ≤ 255 B）
    const budget = zoom < 5.5 ? 90_000 : zoom < 7 ? 180_000 : zoom < 9 ? 400_000 : Infinity;
    return Math.max(1, Math.min(15, Math.ceil(n / budget)));
  }

  /** 透明度：远景车辆极密，叠加混合下要压低单点亮度，否则会饱和成一片白 */
  _alphaFor(z) {
    // 远景：单车点只做「星尘」质感，城市灯火交给光晕图层；越近越清晰
    if (z <= 5) return 0.14;
    if (z >= 11) return 0.95;
    const t = (z - 5) / 6;
    return 0.14 + t * t * 0.81;
  }
}
