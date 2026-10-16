/**
 * 城市光晕图层 —— 全国视角下的「聚合层级」
 *
 * 全国视角里一座城市只占几个像素，单车画得再多也只是一团白点（叠加混合饱和）。
 * 这里改为每座城市一个柔和光团：
 *   - 大小 ∝ √人口（车辆按人口分配，等价于 ∝ √车辆数）；
 *   - 颜色随全国载客率在「空驶青」与「载客金」之间变化，每座城市带微小随机偏差；
 *   - 心跳式脉动（相位各城不同）—— 「全国脉搏」；
 *   - 城市数据流式到达的那一刻闪光点亮，「边下载、边显示」直接可见。
 * 放大到 z≥7 后逐渐淡出，交给单车点精灵 / 胶囊接管。
 *
 * 375 个实例、1 次 Draw Call；每帧只更新若干 uniform，城市点亮时写 4 字节。
 */
import { BaseLayer } from './base.js';
import { program, GLX } from '../core/gl.js';
import { ll2rel } from '../core/projection.js';

const STRIDE_F = 5;   // x, y, size, seed, bornT

const VS = `
precision highp float;
attribute vec2 a_pos;
attribute float a_size;     // 基准直径（CSS 像素，z5 时）
attribute float a_seed;
attribute float a_born;     // 点亮时刻（秒），< 0 表示数据未到
uniform mat4 u_mvpMatrix;
uniform float u_time;
uniform float u_scale;      // 缩放系数 × 设备像素比
uniform float u_alpha;
varying float v_alpha;
varying float v_flash;
varying float v_seed;
void main() {
  if (a_born < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float age = max(0.0, u_time - a_born);
  float birth = smoothstep(0.0, 0.8, age);
  float flash = exp(-age * 2.2);
  float pulse = 1.0 + 0.12 * sin(u_time * 4.4 + a_seed * 6.2831);
  gl_Position = u_mvpMatrix * vec4(a_pos, 0.0, 1.0);
  gl_PointSize = a_size * u_scale * pulse * (0.55 + 0.45 * birth) * (1.0 + flash * 1.6);
  v_alpha = u_alpha * (0.35 + 0.65 * birth);
  v_flash = flash;
  v_seed = a_seed;
}`;

const FS = `
precision mediump float;
uniform float u_trip;        // 全国载客率 0..1
varying float v_alpha;
varying float v_flash;
varying float v_seed;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = clamp(length(d) * 2.0, 0.0, 1.0);
  float t = 1.0 - r;
  float core = pow(t, 6.0);            // 小而亮的核
  float glow = pow(t, 1.8) * 0.75;     // 大而柔的彩色光晕
  // 点亮瞬间的扩散光环
  float ring = smoothstep(0.12, 0.0, abs(r - (1.0 - v_flash))) * v_flash;
  vec3 idle = vec3(0.22, 0.70, 1.00);
  vec3 trip = vec3(1.00, 0.70, 0.26);
  float k = clamp(u_trip + (v_seed - 0.5) * 0.35, 0.0, 1.0);
  vec3 c = mix(idle, trip, k);
  vec3 col = c * (glow * 1.25 + core * 1.2) + vec3(1.0) * core * 0.5 + vec3(0.85, 0.95, 1.0) * ring;
  float a = (glow + core + ring) * v_alpha;
  gl_FragColor = vec4(col, a);
}`;

export class CityGlowLayer extends BaseLayer {
  constructor({ cities, ...opts } = {}) {
    super({ zIndex: 18, blend: 'additive', ...opts });
    this.cities = cities;
    this.index = new Map(cities.map((c, i) => [c.id, i]));
    this.t0 = performance.now();
    this.trip = 0.45;
    this._dirty = [];
  }

  /** 城市数据到达：记录点亮时刻（只记第一次） */
  markLoaded(id) {
    const i = this.index.get(id);
    if (i == null || this._loaded?.[i]) return;
    (this._loaded ||= new Uint8Array(this.cities.length))[i] = 1;
    this._dirty.push([i, (performance.now() - this.t0) / 1000]);
  }

  setTripShare(v) { this.trip = v; }

  onInit(gl) {
    this.glx = new GLX(gl);
    this.prog = program(gl, VS, FS);
    const data = new Float32Array(this.cities.length * STRIDE_F);
    const rel = [0, 0];
    this.cities.forEach((c, i) => {
      ll2rel(c.center[0], c.center[1], rel);
      const o = i * STRIDE_F;
      data[o] = rel[0];
      data[o + 1] = rel[1];
      data[o + 2] = 7 + Math.sqrt(Math.max(30, c.weight)) * 0.62;   // 约 11 ~ 42 CSS 像素（z5）
      data[o + 3] = Math.random();
      data[o + 4] = -1;
    });
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.vramBytes = data.byteLength;
  }

  onFrame(gl, ctx) {
    const zoom = ctx.getZoom();
    // z<7 完全显示，z≥9.5 完全淡出
    const fade = 1 - Math.min(1, Math.max(0, (zoom - 7) / 2.5));
    if (this._dirty.length) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      for (const [i, t] of this._dirty) gl.bufferSubData(gl.ARRAY_BUFFER, (i * STRIDE_F + 4) * 4, new Float32Array([t]));
      this._dirty.length = 0;
    }
    if (fade <= 0.001) return;
    const g = this.prog;
    gl.useProgram(g.p);
    gl.uniformMatrix4fv(g.u.u_mvpMatrix, false, ctx.getMVPMatrix());
    gl.uniform1f(g.u.u_time, (performance.now() - this.t0) / 1000);
    // 光团随缩放适度变大（比地理比例增长慢，避免近景糊成一片）
    gl.uniform1f(g.u.u_scale, ctx.getPixelRatio() * Math.pow(2, (zoom - 5) * 0.55));
    gl.uniform1f(g.u.u_alpha, 0.9 * fade);
    gl.uniform1f(g.u.u_trip, this.trip);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const sB = STRIDE_F * 4;
    const attr = (loc, size, off) => {
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, sB, off);
      this.glx.divisor(loc, 0);
    };
    attr(g.a.a_pos, 2, 0);
    attr(g.a.a_size, 1, 8);
    attr(g.a.a_seed, 1, 12);
    attr(g.a.a_born, 1, 16);
    gl.drawArrays(gl.POINTS, 0, this.cities.length);
    this.countDraw(1);
    this.stats.prims = this.cities.length;
    for (const l of [g.a.a_pos, g.a.a_size, g.a.a_seed, g.a.a_born]) if (l >= 0) gl.disableVertexAttribArray(l);
  }
}
