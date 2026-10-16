/**
 * 城际流线图层 —— 全国视角下城市之间的出行流（模拟）
 *
 * 数据：引力模型 OD —— 强度 ∝ 人口ᵢ × 人口ⱼ / 距离^1.6，取最强的若干城市对；
 *       每座大城市至少连到最近的两座大城市，保证网络连通、不出现孤岛。
 * 几何：每条 OD 是一条二次贝塞尔弧（向一侧弯曲），在 CPU 上一次性细分为线段，
 *       之后只靠 u_time 驱动着色器，光点沿弧线流动，CPU 每帧零开销。
 * 渲染：所有弧线段一个实例缓冲、1 次实例化绘制；z≥7 起淡出。
 */
import { BaseLayer } from './base.js';
import { program, GLX } from '../core/gl.js';
import { ll2rel } from '../core/projection.js';

const STRIDE_F = 8;   // ax, ay, bx, by, u0, u1, seed, weight
const SEGS = 40;      // 每条弧细分段数

const VS = `
precision highp float;
attribute vec2 a_corner;
attribute vec4 a_ab;
attribute vec4 a_meta;       // u0, u1, seed, weight
uniform mat4 u_mvpMatrix;
uniform float u_mpp;
uniform float u_widthPx;
varying float v_u;
varying float v_seed;
varying float v_w;
varying float v_side;
void main() {
  vec2 a = a_ab.xy, b = a_ab.zw;
  vec2 d = b - a;
  float len = max(length(d), 0.001);
  vec2 dir = d / len, perp = vec2(-dir.y, dir.x);
  float w = u_widthPx * (0.6 + 0.9 * a_meta.w) * u_mpp * 0.5;
  vec2 p = a + dir * ((a_corner.x + 0.5) * len) + perp * (a_corner.y * 2.0 * w);
  gl_Position = u_mvpMatrix * vec4(p, 0.0, 1.0);
  v_u = mix(a_meta.x, a_meta.y, a_corner.x + 0.5);
  v_seed = a_meta.z;
  v_w = a_meta.w;
  v_side = a_corner.y * 2.0;
}`;

const FS = `
precision mediump float;
uniform float u_time;
uniform float u_alpha;
varying float v_u;
varying float v_seed;
varying float v_w;
varying float v_side;
void main() {
  float edge = 1.0 - smoothstep(0.3, 1.0, abs(v_side));
  // 两颗光点沿弧线从起点流向终点，速度与相位各弧不同
  float speed = 0.10 + 0.12 * v_seed;
  float h1 = fract(u_time * speed + v_seed);
  float h2 = fract(h1 + 0.5);
  float b1 = fract(h1 - v_u), b2 = fract(h2 - v_u);   // 0 = 光点头部，越大越靠后
  float spark = exp(-b1 * 14.0) + exp(-b2 * 14.0);
  vec3 cold = vec3(0.25, 0.62, 1.0), warm = vec3(1.0, 0.72, 0.30);
  vec3 c = mix(cold, warm, v_u) * (0.45 + spark * 1.8);
  float a = edge * u_alpha * (0.16 + 0.30 * v_w + spark * (0.65 + 0.35 * v_w));
  gl_FragColor = vec4(c, a);
}`;

/** 引力模型挑选 OD 城市对 */
function buildOD(cities, { top = 48, pairs = 240 } = {}) {
  const big = [...cities].filter((c) => c.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, top);
  const km = (a, b) => {
    const dx = (a.center[0] - b.center[0]) * 111.32 * Math.cos(((a.center[1] + b.center[1]) / 2) * Math.PI / 180);
    const dy = (a.center[1] - b.center[1]) * 110.54;
    return Math.hypot(dx, dy);
  };
  const cand = [];
  for (let i = 0; i < big.length; i++) {
    for (let j = i + 1; j < big.length; j++) {
      const d = Math.max(80, km(big[i], big[j]));
      if (d > 2600) continue;
      cand.push({ a: big[i], b: big[j], s: (big[i].weight * big[j].weight) / Math.pow(d, 1.6), d });
    }
  }
  cand.sort((x, y) => y.s - x.s);
  const chosen = new Set(cand.slice(0, pairs));
  // 每座大城市至少连到最近的两座大城市
  for (const c of big) {
    const near = cand.filter((p) => p.a === c || p.b === c).sort((x, y) => x.d - y.d).slice(0, 2);
    near.forEach((p) => chosen.add(p));
  }
  const list = [...chosen];
  const max = Math.max(...list.map((p) => p.s));
  return list.map((p) => ({ ...p, w: Math.pow(p.s / max, 0.35) }));
}

export class FlowLayer extends BaseLayer {
  constructor({ cities, ...opts } = {}) {
    super({ zIndex: 9, blend: 'additive', ...opts });
    this.cities = cities;
    this.t0 = performance.now();
  }

  onInit(gl) {
    this.glx = new GLX(gl);
    this.prog = program(gl, VS, FS);
    const od = buildOD(this.cities);
    const data = new Float32Array(od.length * SEGS * STRIDE_F);
    const A = [0, 0], B = [0, 0];
    let o = 0;
    for (const p of od) {
      ll2rel(p.a.center[0], p.a.center[1], A);
      ll2rel(p.b.center[0], p.b.center[1], B);
      const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
      const dx = B[0] - A[0], dy = B[1] - A[1];
      // 控制点：中点沿法向偏移 22% 弦长，弧线统一朝一侧弯，避免往返两条重叠
      const cx = mx - dy * 0.22, cy = my + dx * 0.22;
      const seed = Math.random();
      let px = A[0], py = A[1];
      for (let s = 1; s <= SEGS; s++) {
        const t = s / SEGS, it = 1 - t;
        const x = it * it * A[0] + 2 * it * t * cx + t * t * B[0];
        const y = it * it * A[1] + 2 * it * t * cy + t * t * B[1];
        data.set([px, py, x, y, (s - 1) / SEGS, t, seed, p.w], o);
        o += STRIDE_F;
        px = x; py = y;
      }
    }
    this.count = od.length * SEGS;
    this.arcs = od.length;
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), gl.STATIC_DRAW);
    this.vramBytes = data.byteLength;
  }

  onFrame(gl, ctx) {
    const zoom = ctx.getZoom();
    const fade = 1 - Math.min(1, Math.max(0, (zoom - 6.5) / 2.5));
    if (fade <= 0.001 || !this.count) return;
    const g = this.prog;
    const glx = this.glx;
    gl.useProgram(g.p);
    gl.uniformMatrix4fv(g.u.u_mvpMatrix, false, ctx.getMVPMatrix());
    gl.uniform1f(g.u.u_mpp, ctx.getUnitsPerPixel());
    gl.uniform1f(g.u.u_widthPx, 3.4);
    gl.uniform1f(g.u.u_time, (performance.now() - this.t0) / 1000);
    gl.uniform1f(g.u.u_alpha, fade);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(g.a.a_corner);
    gl.vertexAttribPointer(g.a.a_corner, 2, gl.FLOAT, false, 0, 0);
    glx.divisor(g.a.a_corner, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(g.a.a_ab);
    gl.vertexAttribPointer(g.a.a_ab, 4, gl.FLOAT, false, STRIDE_F * 4, 0);
    glx.divisor(g.a.a_ab, 1);
    gl.enableVertexAttribArray(g.a.a_meta);
    gl.vertexAttribPointer(g.a.a_meta, 4, gl.FLOAT, false, STRIDE_F * 4, 16);
    glx.divisor(g.a.a_meta, 1);
    glx.drawInstanced(gl.TRIANGLES, this.count, 6, 0);
    this.countDraw(1);
    this.stats.prims = this.count;
    for (const l of [g.a.a_corner, g.a.a_ab, g.a.a_meta]) { glx.divisor(l, 0); gl.disableVertexAttribArray(l); }
  }
}
