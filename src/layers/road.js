/**
 * 路网线图层：实例化线段 + 沿程流动光效
 *
 * 思路：把每条折线拆成线段实例，顶点着色器按「线宽 × 每像素米数」把线段
 * 垂直于走向扩成四边形（两个三角形共 6 个顶点）。这样可以：
 *   - 一次 drawArraysInstanced 画完几十万条线段，线宽恒定不随缩放变粗；
 *   - 流动光效完全由 u_time 驱动的相位计算，CPU 每帧零开销；
 *   - 颜色按道路等级着色，叠加混合下密集处自然发亮。
 *
 * 线段记录 8 × float32：
 *   ax, ay, bx, by（相对城市中心）| cum0, cum1（沿程里程）| kind | widthK
 */
import { BaseLayer } from './base.js';
import { program, GLX } from '../core/gl.js';

const STRIDE_F = 8;

const VS = `
precision highp float;
attribute vec2 a_corner;        // 单位四边形角点
attribute vec4 a_ab;            // ax, ay, bx, by
attribute vec4 a_meta;          // cum0, cum1, kind, widthK
uniform mat4 u_mvpMatrix;
uniform float u_mpp;            // 每像素多少图层单位
uniform vec2 u_origin;          // 该批数据的基准偏移（城市中心相对图层原点）
uniform float u_widthGain;
uniform float u_minPx;
uniform float u_pixelRatio;
uniform float u_time;
uniform float u_flow;           // 流动强度 0..1
uniform float u_alpha;
varying vec2 v_uv;
varying vec3 v_color;
varying float v_phase;
varying float v_alpha;

// 道路等级配色：高速偏暖、主干偏青
vec3 roadColor(float k) {
  if (k < 0.5) return vec3(1.00, 0.72, 0.36);   // 高速
  if (k < 1.5) return vec3(1.00, 0.84, 0.52);   // 快速路
  if (k < 2.5) return vec3(0.45, 0.78, 1.00);   // 主干道
  if (k < 3.5) return vec3(0.36, 0.62, 0.88);   // 次干道
  if (k < 4.5) return vec3(0.30, 0.50, 0.74);   // 支路
  return vec3(0.34, 0.52, 0.72);
}

void main() {
  vec2 a = a_ab.xy, b = a_ab.zw;
  vec2 ab = b - a;
  float len = max(length(ab), 0.0001);
  vec2 dir = ab / len;
  vec2 perp = vec2(-dir.y, dir.x);
  float w = a_meta.w * u_widthGain * u_mpp;
  // 线宽下限 1 像素，避免远景消失
  float halfW = max(w * 0.5, u_minPx * u_pixelRatio * u_mpp * 0.5);
  // a_corner.x ∈ [-0.5, 0.5] → 沿线段方向映射到 [0, len]
  vec2 p = a + dir * ((a_corner.x + 0.5) * len) + perp * (a_corner.y * 2.0 * halfW);
  p += u_origin;
  gl_Position = u_mvpMatrix * vec4(p, 0.0, 1.0);

  v_uv = vec2(a_corner.x + 0.5, a_corner.y + 0.5);
  float cum = mix(a_meta.x, a_meta.y, v_uv.x);
  // 相位沿里程推进，形成光带流动
  v_phase = fract(cum * 0.0016 - u_time * 0.35);
  float kind = a_meta.z;
  v_color = roadColor(kind);
  // 高速更亮，支路更暗，形成层次
  v_alpha = u_alpha * (kind < 1.5 ? 0.85 : kind < 2.5 ? 0.6 : kind < 3.5 ? 0.42 : 0.3);
}
`;

const FS = `
precision mediump float;
varying vec2 v_uv;
varying vec3 v_color;
varying float v_phase;
varying float v_alpha;
uniform float u_flow;
void main() {
  // 横向羽化，让线看着像发光的带子
  float edge = smoothstep(0.0, 0.35, v_uv.y) * smoothstep(1.0, 0.65, v_uv.y);
  float base = edge * v_alpha;
  // 流动光点：相位越接近 0.5 越亮，形成一串沿路行进的光斑
  float flow = smoothstep(0.36, 0.5, v_phase) * smoothstep(0.64, 0.5, v_phase);
  vec3 c = v_color + vec3(0.55, 0.5, 0.4) * flow * u_flow;
  float a = base * (1.0 + flow * u_flow * 1.6);
  if (a < 0.008) discard;
  gl_FragColor = vec4(c, a);
}
`;

export class RoadLayer extends BaseLayer {
  constructor(opts = {}) {
    super({ zIndex: 12, blend: 'additive', ...opts });
    this.capacity = opts.capacity || 800_000;    // 线段容量
    this.origin = opts.origin || [0, 0];         // 批基准（城市中心）
    this.widthGain = opts.widthGain ?? 6.0;
    this.minPx = opts.minPx ?? 0.9;
    this.alpha = opts.alpha ?? 0.9;
    this.flow = opts.flow ?? 0.65;
    this.queue = [];             // 待上传队列：数据到得比上传快时排队，绝不丢弃
    this.uploadBudgetMs = opts.uploadBudgetMs ?? 2.0;
    // 分级 LOD：干线与支线分开存放。全国视角下几十万条支线段都远小于 1 像素，
    // 在分块渲染 GPU 上大量细碎三角形代价很高；远景只画干线，放大后再叠加支线。
    // 三级：0 高速/快速路（始终画）| 1 主干道（z≥7）| 2 次干道/支路（z≥9）
    // 容量按当前数据（8 城真实路网含支路：15.9 万 / 28.1 万 / 60.0 万段）留约 30% 余量。
    // 曾经的 26 万 / 36 万在补入重庆、杭州后就满了，多出的约 26 万段被截掉 —— 现在满了会在控制台报警
    this.tiers = [
      { name: 'trunk', count: 0, cap: 220_000, buf: null, minZoom: 0 },
      { name: 'primary', count: 0, cap: 360_000, buf: null, minZoom: opts.primaryZoom ?? 7 },
      { name: 'minor', count: 0, cap: 800_000, buf: null, minZoom: opts.minorZoom ?? 9 },
    ];
    this.dropped = 0;            // 因容量不足没能上传的线段数（应始终为 0）
  }

  get segments() { return this.tiers.reduce((s, t) => s + t.count, 0); }

  /**
   * 追加一批线段（来自流式解析），按道路等级拆到两级队列。
   * kind ≤ 2（高速/快速路/主干道）以及合成城市的环路放射（kind 6 且宽度系数 ≥ 0.8）进干线级。
   */
  pushSegments(segments) {
    const n = segments.length / STRIDE_F;
    const counts = [0, 0, 0];  // 三个层级各自的线段数
    for (let i = 0; i < n; i++) counts[this._tierOf(segments, i)]++;
    const outs = counts.map((c) => new Float32Array(c * STRIDE_F));
    const pos = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const t = this._tierOf(segments, i);
      outs[t].set(segments.subarray(i * STRIDE_F, (i + 1) * STRIDE_F), pos[t]);
      pos[t] += STRIDE_F;
    }
    outs.forEach((a, t) => { if (a.length) this.queue.push({ tier: t, segments: a, cursor: 0 }); });
    if (!this._first) { this._first = true; this.onFirstData?.(); }
  }

  /** 道路等级 → 显示层级（与 build-lines 的 ROAD_CLASS 对应） */
  _tierOf(seg, i) {
    const kind = seg[i * STRIDE_F + 6];
    return kind <= 1.5 ? 0 : kind <= 2.5 ? 1 : 2;
  }

  /** 待上传的线段数（用于判断是否全部上屏） */
  get pending() {
    return this.queue.reduce((s, j) => s + j.segments.length / STRIDE_F - j.cursor, 0);
  }

  onInit(gl) {
    this.glx = new GLX(gl);
    this.prog = program(gl, VS, FS);
    const quad = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    this.vramBytes = 0;
    for (const t of this.tiers) {
      t.buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, t.buf);
      gl.bufferData(gl.ARRAY_BUFFER, t.cap * STRIDE_F * 4, gl.DYNAMIC_DRAW);
      this.vramBytes += t.cap * STRIDE_F * 4;
    }
  }

  onFrame(gl, ctx) {
    const t0 = performance.now();
    this._upload(gl, t0);
    this._draw(gl, ctx);
  }

  _upload(gl, frameT0) {
    if (!this.queue.length) return;
    let uploaded = 0;
    while (this.queue.length) {
      const job = this.queue[0];
      const t = this.tiers[job.tier];
      const total = job.segments.length / STRIDE_F;
      const chunk = Math.min(16384, t.cap - t.count, total - job.cursor);
      if (chunk > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, t.buf);
        const src = job.segments.subarray(job.cursor * STRIDE_F, (job.cursor + chunk) * STRIDE_F);
        // 只追加写入尚未被绘制的区间，不会与 GPU 读取冲突
        gl.bufferSubData(gl.ARRAY_BUFFER, t.count * STRIDE_F * 4, src);
        job.cursor += chunk;
        t.count += chunk;
        uploaded += src.byteLength;
      }
      if (t.count >= t.cap && job.cursor < total) {
        // 显存缓冲已满：剩余线段无处可放。计数并报警，绝不悄悄截断
        this.dropped += total - job.cursor;
        console.warn(`[road] ${t.name} 级显存缓冲已满（${t.cap.toLocaleString()} 段），丢弃 ${(total - job.cursor).toLocaleString()} 段 —— 请调大 tiers 容量`);
        job.cursor = total;
      }
      if (job.cursor >= total) this.queue.shift();
      if (performance.now() - frameT0 > this.uploadBudgetMs) break;
    }
    this.stats.uploadBytes = uploaded;
    this.stats.uploadMs = performance.now() - frameT0;
  }

  _draw(gl, ctx) {
    if (!this.segments) return;
    const zoom = ctx.getZoom();
    const g = this.prog;
    const glx = this.glx;
    gl.useProgram(g.p);
    gl.uniformMatrix4fv(g.u.u_mvpMatrix, false, ctx.getMVPMatrix());
    gl.uniform1f(g.u.u_mpp, ctx.getUnitsPerPixel() * 0.8);
    gl.uniform2f(g.u.u_origin, this.origin[0], this.origin[1]);
    gl.uniform1f(g.u.u_widthGain, this.widthGain);
    gl.uniform1f(g.u.u_minPx, this.minPx);
    gl.uniform1f(g.u.u_pixelRatio, ctx.getPixelRatio());
    gl.uniform1f(g.u.u_time, performance.now() / 1000);
    gl.uniform1f(g.u.u_flow, this.flow);
    gl.uniform1f(g.u.u_alpha, this.alpha);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(g.a.a_corner);
    gl.vertexAttribPointer(g.a.a_corner, 2, gl.FLOAT, false, 0, 0);
    glx.divisor(g.a.a_corner, 0);

    const sB = STRIDE_F * 4;
    let prims = 0;
    for (const t of this.tiers) {
      if (!t.count || zoom < t.minZoom) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, t.buf);
      gl.enableVertexAttribArray(g.a.a_ab);
      gl.vertexAttribPointer(g.a.a_ab, 4, gl.FLOAT, false, sB, 0);
      glx.divisor(g.a.a_ab, 1);
      gl.enableVertexAttribArray(g.a.a_meta);
      gl.vertexAttribPointer(g.a.a_meta, 4, gl.FLOAT, false, sB, 16);
      glx.divisor(g.a.a_meta, 1);
      glx.drawInstanced(gl.TRIANGLES, t.count, 6, 0);
      this.countDraw(1);
      prims += t.count;
    }
    this.stats.prims = prims;

    for (const l of [g.a.a_corner, g.a.a_ab, g.a.a_meta]) {
      if (l >= 0) { glx.divisor(l, 0); gl.disableVertexAttribArray(l); }
    }
  }
}
