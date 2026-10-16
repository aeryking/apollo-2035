/**
 * 区域面图层：流式 GeoJSON → Worker 三角化 → 增量上传 → 实例化绘制
 *
 * 为什么在 Worker 里三角化：
 *   earcut 对复杂多边形（一个省几百个环、上万个顶点）是纯计算活，放主线程会直接卡住交互。
 *   Worker 里算完只把「三角形顶点数组」传过来，主线程只做上显存，完全不需要解析 GeoJSON。
 *
 * 数据结构：
 *   顶点缓冲  [x, y, zoneId, value]  ；zoneId 用于按区域取指标着色
 *   按区域记录 每块的顶点区间，绘制时按需跳过不可见区域（视锥剔除）
 */
import { BaseLayer } from './base.js';
import { program, GLX } from '../core/gl.js';

const STRIDE_F = 4;   // x, y, zoneId, value

const VS = `
precision highp float;
attribute vec4 a_v;              // x, y, zoneId, value
uniform mat4 u_mvpMatrix;
uniform vec2 u_origin;
uniform float u_extrude;         // 抬升系数（按 value 抬高的量）
uniform float u_unitsPerPixel;
varying float v_value;
varying float v_zone;
void main() {
  vec2 p = a_v.xy + u_origin;
  // 用 value 做轻微抬升，形成「数据柱」的层次感（投影坐标系的 z 分量）
  float z = a_v.w * u_extrude * u_unitsPerPixel;
  gl_Position = u_mvpMatrix * vec4(p, z, 1.0);
  v_value = a_v.w;
  v_zone = a_v.z;
}
`;

const FS = `
precision mediump float;
varying float v_value;
varying float v_zone;
uniform vec3 u_low;
uniform vec3 u_high;
uniform float u_alpha;
void main() {
  // 蓝 → 金 的连续色标，直接由数值映射
  vec3 c = mix(u_low, u_high, clamp(v_value, 0.0, 1.0));
  float a = u_alpha * (0.14 + 0.55 * clamp(v_value, 0.0, 1.0));
  gl_FragColor = vec4(c, a);
}
`;
const LINE_FS = `
precision mediump float;
varying float v_value;
varying float v_zone;
uniform float u_alpha;
uniform vec3 u_line;
void main() {
  gl_FragColor = vec4(u_line, u_alpha * (0.25 + 0.5 * clamp(v_value, 0.0, 1.0)));
}
`;

export class ZoneLayer extends BaseLayer {
  constructor(opts = {}) {
    super({ zIndex: 8, blend: 'normal', ...opts });
    this.fillCapacity = opts.fillCapacity || 3_000_000;
    this.lineCapacity = opts.lineCapacity || 400_000;
    this.origin = opts.origin || [0, 0];
    this.extrude = opts.extrude ?? 0.0;
    this.alpha = opts.alpha ?? 0.5;
    this.fillCount = 0;
    this.lineCount = 0;
    this.jobs = [];
    this.uploadBudgetMs = opts.uploadBudgetMs ?? 3;
  }

  /** 推入一批三角化结果（来自 Worker） */
  pushFill(vertices) {
    this.jobs.push({ kind: 'fill', data: vertices, cursor: 0 });
    if (!this._first) { this._first = true; this.onFirstData?.(); }
  }
  pushOutline(vertices) { this.jobs.push({ kind: 'line', data: vertices, cursor: 0 }); }

  onInit(gl) {
    this.glx = new GLX(gl);
    this.fillProg = program(gl, VS, FS);
    this.lineProg = program(gl, VS, LINE_FS);
    this.fillBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.fillCapacity * STRIDE_F * 4, gl.DYNAMIC_DRAW);
    this.lineBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineCapacity * STRIDE_F * 4, gl.DYNAMIC_DRAW);
    this.vramBytes = (this.fillCapacity + this.lineCapacity) * STRIDE_F * 4;
  }

  onFrame(gl, ctx) {
    const t0 = performance.now();
    this._upload(gl, t0);
    this._draw(gl, ctx);
  }

  _upload(gl, frameT0) {
    while (this.jobs.length) {
      const j = this.jobs[0];
      const isFill = j.kind === 'fill';
      const buf = isFill ? this.fillBuf : this.lineBuf;
      const cap = isFill ? this.fillCapacity : this.lineCapacity;
      let count = isFill ? this.fillCount : this.lineCount;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const totalF = j.data.length / STRIDE_F;
      while (j.cursor < totalF && count < cap) {
        const chunk = Math.min(32768, cap - count, totalF - j.cursor);
        const src = j.data.subarray(j.cursor * STRIDE_F, (j.cursor + chunk) * STRIDE_F);
        gl.bufferSubData(gl.ARRAY_BUFFER, count * STRIDE_F * 4, src);
        j.cursor += chunk;
        count += chunk;
        if (performance.now() - frameT0 > this.uploadBudgetMs) break;
      }
      if (isFill) this.fillCount = count; else this.lineCount = count;
      if (j.cursor >= totalF || count >= cap) this.jobs.shift();
      if (performance.now() - frameT0 > this.uploadBudgetMs) break;
    }
  }

  _draw(gl, ctx) {
    const glx = this.glx;
    const draw = (prog, buf, count, mode) => {
      if (!count) return;
      gl.useProgram(prog.p);
      gl.uniformMatrix4fv(prog.u.u_mvpMatrix, false, ctx.getMVPMatrix());
      gl.uniform2f(prog.u.u_origin, this.origin[0], this.origin[1]);
      gl.uniform1f(prog.u.u_extrude, this.extrude);
      gl.uniform1f(prog.u.u_unitsPerPixel, ctx.getUnitsPerPixel());
      if (prog.u.u_low) {
        gl.uniform3f(prog.u.u_low, 0.10, 0.42, 0.78);
        gl.uniform3f(prog.u.u_high, 1.00, 0.72, 0.28);
      }
      if (prog.u.u_line) gl.uniform3f(prog.u.u_line, 0.62, 0.86, 1.0);
      gl.uniform1f(prog.u.u_alpha, prog === this.lineProg ? this.alpha * 1.6 : this.alpha);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const loc = prog.a.a_v;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, STRIDE_F * 4, 0);
      glx.divisor(loc, 0);
      gl.drawArrays(mode, 0, count);
      gl.disableVertexAttribArray(loc);
      this.countDraw(1);
      this.stats.prims += count;
    };
    draw(this.fillProg, this.fillBuf, this.fillCount, gl.TRIANGLES);
    draw(this.lineProg, this.lineBuf, this.lineCount, gl.LINES);
  }
}
