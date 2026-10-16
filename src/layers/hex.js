/**
 * 需求预测 3D 六边形柱图层（实例化绘制）
 *
 *  - 一个六棱柱模板（顶面 6 个三角形 + 侧面 12 个三角形 = 54 个顶点），所有格子共用；
 *  - 每个格子只有两个实例属性：中心坐标（静态）+ 需求值（每秒更新一次，几 KB）；
 *  - 高度过渡在顶点着色器里完成：保留上一次与本次的数值，按时间插值，柱子平滑升降；
 *  - 开启深度测试，柱体之间、柱体与底图建筑之间遮挡关系正确。
 */
import { BaseLayer } from './base.js';
import { program, GLX } from '../core/gl.js';

const VS = `
precision highp float;
attribute vec3 a_local;      // 模板顶点：x,y 为单位六边形，z 为 0(底)/1(顶)
attribute float a_shade;     // 侧面明暗
attribute vec2 a_center;     // 实例：格子中心
attribute float a_v0;        // 实例：上一次需求值
attribute float a_v1;        // 实例：本次需求值
uniform mat4 u_mvpMatrix;
uniform float u_radius;      // 六边形半径（图层单位）
uniform float u_height;      // 最大高度（图层单位）
uniform float u_mix;         // 0 → v0, 1 → v1
uniform float u_rise;        // 入场动画 0..1
varying vec3 v_color;
varying float v_alpha;

vec3 ramp(float t) {
  // 深蓝 → 青 → 金 → 橙红：低需求冷色、高需求暖色
  vec3 c0 = vec3(0.10, 0.30, 0.75);
  vec3 c1 = vec3(0.15, 0.80, 0.95);
  vec3 c2 = vec3(1.00, 0.80, 0.30);
  vec3 c3 = vec3(1.00, 0.35, 0.25);
  if (t < 0.4) return mix(c0, c1, t / 0.4);
  if (t < 0.75) return mix(c1, c2, (t - 0.4) / 0.35);
  return mix(c2, c3, (t - 0.75) / 0.25);
}

void main() {
  float v = mix(a_v0, a_v1, u_mix);
  // 低需求的格子压得很矮，突出热点；平方曲线拉开层次
  float h = v * v * u_height * u_rise + 8.0;
  vec2 p = a_center + a_local.xy * u_radius * 0.92;
  gl_Position = u_mvpMatrix * vec4(p, a_local.z * h, 1.0);
  v_color = ramp(v) * a_shade;
  v_alpha = 0.18 + 0.72 * smoothstep(0.05, 0.6, v);
}
`;

const FS = `
precision mediump float;
varying vec3 v_color;
varying float v_alpha;
void main() { gl_FragColor = vec4(v_color, v_alpha); }
`;

/** 六棱柱模板：顶面 + 侧面 */
function prism() {
  const v = [];
  const corner = (i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return [Math.cos(a), Math.sin(a)];
  };
  for (let i = 0; i < 6; i++) {
    const [ax, ay] = corner(i), [bx, by] = corner((i + 1) % 6);
    // 顶面三角形
    v.push(0, 0, 1, 1.0, ax, ay, 1, 1.0, bx, by, 1, 1.0);
    // 侧面两个三角形，按朝向给明暗
    const shade = 0.55 + 0.35 * Math.abs(Math.cos((Math.PI / 3) * i + Math.PI / 3));
    v.push(ax, ay, 0, shade, bx, by, 0, shade, bx, by, 1, shade);
    v.push(ax, ay, 0, shade, bx, by, 1, shade, ax, ay, 1, shade);
  }
  return new Float32Array(v);
}

export class HexLayer extends BaseLayer {
  constructor(opts = {}) {
    super({ zIndex: 15, blend: 'normal', depth: true, ...opts });
    this.heightM = opts.height ?? 4200;
    this.count = 0;
    this.radius = 0;
    this.visible = opts.visible ?? false;
    this._pending = null;
    this._swapT = 0;
    this._rise = 0;
  }

  setGrid(cells, radius) { this._grid = { cells, radius }; }
  setValues(values) { this._pending = values; }

  onInit(gl) {
    this.glx = new GLX(gl);
    this.prog = program(gl, VS, FS);
    this.tpl = prism();
    this.tplBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tplBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.tpl, gl.STATIC_DRAW);
    this.centerBuf = gl.createBuffer();
    this.valBufs = [gl.createBuffer(), gl.createBuffer()];
    this.cur = 0;
  }

  onFrame(gl, ctx) {
    if (this._grid) {
      const { cells, radius } = this._grid;
      this.count = cells.length / 2;
      this.radius = radius;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.centerBuf);
      gl.bufferData(gl.ARRAY_BUFFER, cells, gl.STATIC_DRAW);
      const zeros = new Float32Array(this.count);
      for (const b of this.valBufs) { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, zeros, gl.DYNAMIC_DRAW); }
      this.vramBytes = cells.byteLength + zeros.byteLength * 2 + this.tpl.byteLength;
      this._grid = null;
    }
    if (this._pending && this.count) {
      // 双缓冲：新值写进「另一块」，着色器在两块之间插值
      this.cur ^= 1;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.valBufs[this.cur]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._pending.subarray(0, this.count));
      this._pending = null;
      this._swapT = performance.now();
    }
    if (!this.count) return;
    this._rise = Math.min(1, this._rise + 0.02);

    const g = this.prog;
    const glx = this.glx;
    gl.useProgram(g.p);
    gl.uniformMatrix4fv(g.u.u_mvpMatrix, false, ctx.getMVPMatrix());
    gl.uniform1f(g.u.u_radius, this.radius);
    gl.uniform1f(g.u.u_height, this.heightM * 1.3);
    gl.uniform1f(g.u.u_mix, Math.min(1, (performance.now() - this._swapT) / 900));
    gl.uniform1f(g.u.u_rise, this._rise);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.tplBuf);
    gl.enableVertexAttribArray(g.a.a_local);
    gl.vertexAttribPointer(g.a.a_local, 3, gl.FLOAT, false, 16, 0);
    glx.divisor(g.a.a_local, 0);
    gl.enableVertexAttribArray(g.a.a_shade);
    gl.vertexAttribPointer(g.a.a_shade, 1, gl.FLOAT, false, 16, 12);
    glx.divisor(g.a.a_shade, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.centerBuf);
    gl.enableVertexAttribArray(g.a.a_center);
    gl.vertexAttribPointer(g.a.a_center, 2, gl.FLOAT, false, 0, 0);
    glx.divisor(g.a.a_center, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.valBufs[this.cur ^ 1]);
    gl.enableVertexAttribArray(g.a.a_v0);
    gl.vertexAttribPointer(g.a.a_v0, 1, gl.FLOAT, false, 0, 0);
    glx.divisor(g.a.a_v0, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.valBufs[this.cur]);
    gl.enableVertexAttribArray(g.a.a_v1);
    gl.vertexAttribPointer(g.a.a_v1, 1, gl.FLOAT, false, 0, 0);
    glx.divisor(g.a.a_v1, 1);

    glx.drawInstanced(gl.TRIANGLES, this.count, this.tpl.length / 4, 0);
    this.countDraw(1);
    this.stats.prims = this.count;

    for (const l of [g.a.a_local, g.a.a_shade, g.a.a_center, g.a.a_v0, g.a.a_v1]) {
      if (l >= 0) { glx.divisor(l, 0); gl.disableVertexAttribArray(l); }
    }
  }
}
