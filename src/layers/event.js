/**
 * 事件图层：生命通道 + 特种车辆
 *   - 通道线：实例化线段，按「沿程里程 vs 头车位置」着色：
 *     已驶过的一段暗下去，前方让行区间亮起并有脉冲光沿路向前推进；
 *   - 车辆：点精灵画的脉冲光环（模拟警灯）。120 救护车单车红蓝闪；
 *     119 消防车队 = 警车开道（蓝红快闪）+ 4 辆消防车（红橙），沿路线保持车距跟随头车。
 *   所有车共用一次 POINTS 绘制，种类与大小作为顶点属性。
 */
import { BaseLayer } from './base.js';
import { program, GLX } from '../core/gl.js';
import { buildVehicleAtlas, ICON_CELL, ATLAS_SIZE, LIGHT_RECTS } from './vehicleIcons.js';

const LINE_VS = `
precision highp float;
attribute vec2 a_corner;
attribute vec4 a_ab;        // ax, ay, bx, by
attribute vec2 a_cum;       // 起点/终点沿程里程
uniform mat4 u_mvpMatrix;
uniform float u_mpp;
uniform float u_widthPx;
varying float v_s;
varying float v_side;
void main() {
  vec2 a = a_ab.xy, b = a_ab.zw;
  vec2 d = b - a;
  float len = max(length(d), 0.001);
  vec2 dir = d / len, perp = vec2(-dir.y, dir.x);
  float hw = u_widthPx * 0.5 * u_mpp;
  vec2 p = a + dir * ((a_corner.x + 0.5) * len) + perp * (a_corner.y * 2.0 * hw);
  gl_Position = u_mvpMatrix * vec4(p, 0.0, 1.0);
  v_s = mix(a_cum.x, a_cum.y, a_corner.x + 0.5);
  v_side = a_corner.y * 2.0;
}`;
const LINE_FS = `
precision mediump float;
varying float v_s;
varying float v_side;
uniform float u_pos;        // 头车沿程位置
uniform float u_ahead;      // 让行区间长度
uniform float u_time;
uniform float u_tail;       // 车队长度（头车到尾车，单车为 0）
uniform float u_trail;      // 光迹拖尾长度
uniform vec3 u_trailColor;
void main() {
  float edge = 1.0 - smoothstep(0.55, 1.0, abs(v_side));
  float behind = step(v_s, u_pos);
  float ahead = step(u_pos, v_s) * (1.0 - smoothstep(u_pos + u_ahead * 0.6, u_pos + u_ahead, v_s));
  float pulse = 0.5 + 0.5 * sin((v_s - u_pos) * 0.012 - u_time * 9.0);
  vec3 c = mix(vec3(1.0, 0.16, 0.12), vec3(1.0, 0.92, 0.85), pulse * ahead * 0.8);
  // 整条通道常亮（让观众看清车要走的路），已驶过段变暗，前方让行段最亮并有脉冲
  float rest = (1.0 - behind) * (1.0 - ahead);
  float a = edge * (behind * 0.3 + ahead * (0.8 + 0.2 * pulse) + rest * 0.5);
  // 车队所在路段（尾车后 30 m 到头车前 30 m）压暗：车辆图标要和背景拉开对比，不被通道光带吃掉
  float under = step(u_pos - u_tail - 37.5, v_s) * step(v_s, u_pos + 37.5);
  a *= 1.0 - 0.75 * under;
  // 光迹拖尾：从尾车后面开始、往后渐隐的细亮带（长曝光照片里车灯拉出的光轨），车身底下不亮
  float tailEnd = u_pos - u_tail - 37.5;
  float tr = step(v_s, tailEnd) * smoothstep(tailEnd - u_trail, tailEnd, v_s);
  tr *= tr;
  float streak = 1.0 - smoothstep(0.0, 0.42, abs(v_side));
  c += u_trailColor * tr * streak * 1.6;
  a += tr * streak * 0.95;
  if (a < 0.01) discard;
  gl_FragColor = vec4(c, a);
}`;

const DOT_VS = `
precision highp float;
attribute vec2 a_p;
attribute vec2 a_meta;      // 种类（0 救护车 / 1 警车 / 2 消防车），点大小（CSS 像素）
uniform mat4 u_mvpMatrix;
uniform float u_dpr;
varying float v_kind;
varying float v_phase;
void main() {
  gl_Position = u_mvpMatrix * vec4(a_p, 0.0, 1.0);
  gl_PointSize = a_meta.y * u_dpr;
  v_kind = a_meta.x;
  v_phase = fract(a_p.x * 0.0137 + a_p.y * 0.0091);   // 每辆车闪烁相位错开
}`;
const DOT_FS = `
precision mediump float;
uniform float u_time;
varying float v_kind;
varying float v_phase;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float ring = fract(u_time * 1.4 + v_phase);
  float wave = smoothstep(0.08, 0.0, abs(r - ring)) * (1.0 - ring);
  // 车队（警车 / 消防车）的亮核更大：一列车在倾斜视角下也能一辆辆分清
  float core = v_kind < 0.5 ? smoothstep(0.22, 0.12, r) : smoothstep(0.34, 0.2, r);
  vec3 c;
  if (v_kind < 0.5) {            // 救护车：红 / 蓝交替
    c = mix(vec3(1.0, 0.18, 0.22), vec3(0.35, 0.55, 1.0), step(0.5, fract(u_time * 2.5)));
  } else if (v_kind < 1.5) {     // 警车：蓝 / 红快闪
    c = mix(vec3(0.25, 0.45, 1.0), vec3(1.0, 0.15, 0.2), step(0.5, fract(u_time * 4.0)));
  } else {                       // 消防车：红 / 橙
    c = mix(vec3(1.0, 0.12, 0.08), vec3(1.0, 0.55, 0.1), step(0.5, fract(u_time * 2.0 + v_phase)));
  }
  float a = core + wave * 0.9;
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(c, vec3(1.0), core * 0.6), a);
}`;

// 车辆图标：每辆一个实例四边形，平铺在地面上、沿行驶方向旋转；屏幕上保持固定像素大小
const ICON_VS = `
precision highp float;
attribute vec2 a_corner;    // -0.5..0.5；y 为车头方向
attribute vec4 a_inst;      // x, y, 朝向（弧度，与 setHeading 同一约定）, 种类
uniform mat4 u_mvpMatrix;
uniform float u_mpp;
uniform vec3 u_lenPx;       // 三种车的车长（CSS 像素）：救护车 / 警车 / 消防车
uniform float u_gap;        // 车队车距（图层坐标）；0 = 单车
varying vec2 v_uv;
varying vec2 v_local;
varying float v_kind;
void main() {
  float k = a_inst.w;
  v_kind = k;
  float lenPx = k < 0.5 ? u_lenPx.x : (k < 1.5 ? u_lenPx.y : u_lenPx.z);
  float L = lenPx * u_mpp;
  // 图标按屏幕像素定大小、车距按地图距离算：拉远时车长不超过车距的 70%，任何缩放都不首尾相连
  if (u_gap > 0.0) L = min(L, u_gap * 0.7);
  float W = L * ${(ICON_CELL.w / ICON_CELL.h).toFixed(4)};
  vec2 dir = vec2(sin(a_inst.z), cos(a_inst.z));
  vec2 right = vec2(dir.y, -dir.x);
  vec2 p = a_inst.xy + dir * (a_corner.y * L) + right * (a_corner.x * W);
  gl_Position = u_mvpMatrix * vec4(p, 0.0, 1.0);
  float cw = ${(ICON_CELL.w / ATLAS_SIZE).toFixed(6)}, ch = ${(ICON_CELL.h / ATLAS_SIZE).toFixed(6)};
  v_uv = vec2((k + a_corner.x + 0.5) * cw, (0.5 - a_corner.y) * ch);
  v_local = a_corner + 0.5;
}`;
const ICON_FS = `
precision mediump float;
uniform sampler2D u_tex;
uniform float u_time;
varying vec2 v_uv;
varying vec2 v_local;
varying float v_kind;
uniform vec4 u_light[3];    // 各车型警灯位置 [x0, x1, y0, y1]（格内比例，y 从车头量起）
void main() {
  vec4 t = texture2D(u_tex, v_uv);          // 预乘 alpha
  if (t.a < 0.02) discard;
  vec3 rgb = t.rgb / max(t.a, 0.001);
  // 警灯：按位置替换成左右两半红蓝交替闪烁
  vec4 R = v_kind < 0.5 ? u_light[0] : (v_kind < 1.5 ? u_light[1] : u_light[2]);
  float fy = 1.0 - v_local.y;               // 从车头量起
  float isLight = step(R.x, v_local.x) * step(v_local.x, R.y) * step(R.z, fy) * step(fy, R.w);
  float flip = step(0.5, fract(u_time * 3.0));
  float left = step(v_local.x, 0.5);
  vec3 red = vec3(1.0, 0.12, 0.15), blue = vec3(0.2, 0.45, 1.0);
  vec3 light = mix(mix(blue, red, left), mix(red, blue, left), flip) * 1.6;
  rgb = mix(rgb, light, isLight);
  gl_FragColor = vec4(rgb * t.a, t.a);
}`;

export class EventLayer extends BaseLayer {
  constructor(opts = {}) {
    super({ zIndex: 30, blend: 'additive', ...opts });
    this.segCount = 0;
    this.pos = 0;
    this.ahead = 1600 * 1.3;
    this.amb = null;
    this._pending = null;
    this._dbg = new URLSearchParams(location.search).get('dbgev') ? performance.now() : 0;
  }

  /** kind：ambulance / fire；units：车辆数；gap：车距（MC） */
  setCorridor(pts, cum, { kind = 'ambulance', units = 1, gap = 0 } = {}) {
    this.pts = pts;
    this.cum = cum;
    this.kind = kind;
    this.units = units;
    this.gap = gap;
    this._s0 = 0; this._t0 = performance.now(); this._vel = 0;
    // 折线 → 线段实例 [ax, ay, bx, by, cum0, cum1]
    const n = pts.length / 2 - 1;
    const seg = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      seg.set([pts[i * 2], pts[i * 2 + 1], pts[i * 2 + 2], pts[i * 2 + 3], cum[i], cum[i + 1]], i * 6);
    }
    this._pending = seg;
  }

  /** 调试：读回通道线上若干点的像素与 GL 状态，回传开发服务器（?dbgev=1） */
  _debugProbe(gl, ctx) {
    this._dbgSent = true;
    const m = ctx.getMVPMatrix();
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const probe = (x, y) => {
      const cx = m[0] * x + m[4] * y + m[12], cy = m[1] * x + m[5] * y + m[13], cw = m[3] * x + m[7] * y + m[15];
      const px = Math.round((cx / cw * 0.5 + 0.5) * W), py = Math.round((cy / cw * 0.5 + 0.5) * H);
      const b = new Uint8Array(4);
      if (px >= 0 && py >= 0 && px < W && py < H) gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
      return { px, py, rgba: Array.from(b) };
    };
    const p = this.pts, n = p.length / 2;
    const samples = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => {
      const k = Math.min(n - 2, Math.floor(f * (n - 1)));
      return { k, cum: this.cum[k], ...probe((p[k * 2] + p[k * 2 + 2]) / 2, (p[k * 2 + 1] + p[k * 2 + 3]) / 2) };
    });
    const r = {
      err: gl.getError(), segCount: this.segCount, pos: this.pos, len: this.cum[this.cum.length - 1], mpp: ctx.getUnitsPerPixel(),
      stencil: gl.isEnabled(gl.STENCIL_TEST), stencilFunc: gl.getParameter(gl.STENCIL_FUNC), stencilRef: gl.getParameter(gl.STENCIL_REF),
      stencilMask: gl.getParameter(gl.STENCIL_VALUE_MASK), depth: gl.isEnabled(gl.DEPTH_TEST), depthFunc: gl.getParameter(gl.DEPTH_FUNC),
      blend: gl.isEnabled(gl.BLEND), cull: gl.isEnabled(gl.CULL_FACE), cullMode: gl.getParameter(gl.CULL_FACE_MODE), frontFace: gl.getParameter(gl.FRONT_FACE),
      colorMask: gl.getParameter(gl.COLOR_WRITEMASK), samples, first: Array.from(p.slice(0, 4)),
    };
    fetch('/__bench/save?name=dbg-event.json', { method: 'POST', body: JSON.stringify(r) });
  }

  clear() { this.segCount = 0; this.amb = null; this.pts = null; }

  /** Worker 每秒上报一次位置；主线程按速度外推，救护车每帧平滑前进 */
  setAmbulance(x, y, s) {
    const now = performance.now();
    if (this._t0 && s > this._s0) this._vel = (s - this._s0) / Math.max(1, now - this._t0);
    this._s0 = s;
    this._t0 = now;
    this.amb = [x, y];
  }

  _extrapolate() {
    if (!this.pts || this._s0 == null) return;
    const s = Math.min(this.cum[this.cum.length - 1], this._s0 + this._vel * (performance.now() - this._t0));
    this.pos = s;
    let k = 0;
    while (k < this.cum.length - 2 && this.cum[k + 1] < s) k++;
    const L = Math.max(0.001, this.cum[k + 1] - this.cum[k]);
    const f = Math.max(0, Math.min(1, (s - this.cum[k]) / L));
    const p = this.pts;
    this.amb = [p[k * 2] + (p[k * 2 + 2] - p[k * 2]) * f, p[k * 2 + 1] + (p[k * 2 + 3] - p[k * 2 + 1]) * f];
  }

  /** 沿程位置 → 坐标 */
  _at(s, out) {
    const cum = this.cum, p = this.pts;
    let k = 0;
    while (k < cum.length - 2 && cum[k + 1] < s) k++;
    const f = Math.max(0, Math.min(1, (s - cum[k]) / Math.max(0.001, cum[k + 1] - cum[k])));
    out[0] = p[k * 2] + (p[k * 2 + 2] - p[k * 2]) * f;
    out[1] = p[k * 2 + 1] + (p[k * 2 + 3] - p[k * 2 + 1]) * f;
    return out;
  }

  /**
   * 无人机视角（追车镜头）：画面中心看向头车前方约 160 m，朝向取「头车后 150 m → 前 450 m」
   * 这一段的方向 —— 跨度够长，经过路口折线时朝向不会抖。返回的 heading 直接可用于 setHeading。
   */
  chase() {
    if (!this.pts || !this.amb) return null;
    const M = 1.25;   // 米 → MC
    const a = this._at(Math.max(0, this.pos - 150 * M), [0, 0]);
    const b = this._at(this.pos + 450 * M, [0, 0]);
    const look = this._at(this.pos + 160 * M, [0, 0]);
    // 百度 setHeading 逆时针为正（实测：取负后前进方向正好朝屏幕正上方）
    return { x: look[0], y: look[1], heading: (-Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI };
  }

  /** 车队各车的 [x, y, 种类, 大小]；还没驶入路线起点的后车不画 */
  _units() {
    const out = [], q = [0, 0];
    const n = this.units || 1;
    for (let i = 0; i < n; i++) {
      const s = this.pos - i * (this.gap || 0);
      if (s < 0) break;
      this._at(s, q);
      if (this.kind === 'fire') out.push(q[0], q[1], i === 0 ? 1 : 2, i === 0 ? 44 : 40);
      else out.push(q[0], q[1], 0, 56);
    }
    return new Float32Array(out);
  }

  onInit(gl) {
    this.glx = new GLX(gl);
    this.lineProg = program(gl, LINE_VS, LINE_FS);
    this.dotProg = program(gl, DOT_VS, DOT_FS);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), gl.STATIC_DRAW);
    this.segBuf = gl.createBuffer();
    this.dotBuf = gl.createBuffer();
    // 车辆图标：图集纹理（预乘 alpha，避免透明边缘发黑）+ 实例缓冲。
    // 纹理操作一律走「真实」WebGL 上下文：图层拿到的 gl 是百度安全模式的代理，带状态缓存，
    // 实测经代理绑定的纹理在绘制时采样全黑（图集内容本身无误）。改真实状态后都原样还原，代理缓存不受影响
    this.iconProg = program(gl, ICON_VS, ICON_FS);
    this.iconBuf = gl.createBuffer();
    const cv = gl.canvas || document.querySelector('#map canvas');
    const rgl = (this.rgl = cv.getContext('webgl') || cv.getContext('experimental-webgl'));
    this.tex = rgl.createTexture();
    const pu = rgl.getParameter(rgl.ACTIVE_TEXTURE);
    rgl.activeTexture(rgl.TEXTURE7);
    const prevTex = rgl.getParameter(rgl.TEXTURE_BINDING_2D);
    rgl.bindTexture(rgl.TEXTURE_2D, this.tex);
    rgl.pixelStorei(rgl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    rgl.texImage2D(rgl.TEXTURE_2D, 0, rgl.RGBA, rgl.RGBA, rgl.UNSIGNED_BYTE, buildVehicleAtlas());
    rgl.pixelStorei(rgl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);   // 还原：底图自己的纹理上传依赖默认值
    rgl.generateMipmap(rgl.TEXTURE_2D);
    rgl.texParameteri(rgl.TEXTURE_2D, rgl.TEXTURE_MIN_FILTER, rgl.LINEAR_MIPMAP_LINEAR);
    rgl.texParameteri(rgl.TEXTURE_2D, rgl.TEXTURE_MAG_FILTER, rgl.LINEAR);
    rgl.texParameteri(rgl.TEXTURE_2D, rgl.TEXTURE_WRAP_S, rgl.CLAMP_TO_EDGE);
    rgl.texParameteri(rgl.TEXTURE_2D, rgl.TEXTURE_WRAP_T, rgl.CLAMP_TO_EDGE);
    rgl.bindTexture(rgl.TEXTURE_2D, prevTex);
    rgl.activeTexture(pu);
  }

  /** 沿程位置 s 处的行驶朝向（弧度，与 setHeading 同一约定：atan2(dx, dy)） */
  _dirAt(s) {
    const M = 1.25;
    const a = this._at(Math.max(0, s - 12 * M), [0, 0]), b = this._at(s + 12 * M, [0, 0]);
    return Math.atan2(b[0] - a[0], b[1] - a[1]);
  }

  /**
   * 画车辆图标：整遍直接在真实 WebGL 上下文上执行（见 onInit 的说明 —— 经代理绑定的纹理在绘制时采样全黑），
   * 普通透明叠加。改动的真实状态（程序 / 缓冲 / 纹理单元 / 混合 / 顶点属性）画完逐项还原，代理缓存保持一致。
   */
  _drawIcons(gl, ctx, units, t) {
    const n = units.length / 4;
    const inst = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const s = this.pos - i * (this.gap || 0);
      inst.set([units[i * 4], units[i * 4 + 1], this._dirAt(Math.max(0, s)), units[i * 4 + 2]], i * 4);
    }
    const r = this.rgl, g = this.iconProg;
    const ext = (this._inst ||= r.getExtension('ANGLE_instanced_arrays'));
    const vaoExt = (this._vao ||= r.getExtension('OES_vertex_array_object'));
    const saved = {
      prog: r.getParameter(r.CURRENT_PROGRAM), buf: r.getParameter(r.ARRAY_BUFFER_BINDING),
      vao: vaoExt ? r.getParameter(vaoExt.VERTEX_ARRAY_BINDING_OES) : null,
      unit: r.getParameter(r.ACTIVE_TEXTURE),
      blend: [r.BLEND_SRC_RGB, r.BLEND_DST_RGB, r.BLEND_SRC_ALPHA, r.BLEND_DST_ALPHA].map((q) => r.getParameter(q)),
      blendOn: r.isEnabled(r.BLEND),
    };
    if (vaoExt) vaoExt.bindVertexArrayOES(null);
    r.activeTexture(r.TEXTURE7);
    const prevTex = r.getParameter(r.TEXTURE_BINDING_2D);
    r.bindTexture(r.TEXTURE_2D, this.tex);
    r.enable(r.BLEND);
    r.blendFuncSeparate(r.ONE, r.ONE_MINUS_SRC_ALPHA, r.ONE, r.ONE_MINUS_SRC_ALPHA);
    r.useProgram(g.p);
    r.uniformMatrix4fv(g.u.u_mvpMatrix, false, ctx.getMVPMatrix());
    r.uniform1f(g.u.u_mpp, ctx.getUnitsPerPixel());
    r.uniform3f(g.u.u_lenPx, 40, 34, 44);             // 救护车 / 警车 / 消防车（屏幕上的车长，CSS 像素）
    r.uniform1f(g.u.u_time, t);
    r.uniform1f(g.u.u_gap, (this.units || 1) > 1 ? this.gap || 0 : 0);
    r.uniform1i(g.u.u_tex, 7);
    r.uniform4fv(r.getUniformLocation(g.p, 'u_light'), LIGHT_RECTS.flat());
    r.bindBuffer(r.ARRAY_BUFFER, this.cornerBuf);
    r.enableVertexAttribArray(g.a.a_corner);
    r.vertexAttribPointer(g.a.a_corner, 2, r.FLOAT, false, 0, 0);
    ext.vertexAttribDivisorANGLE(g.a.a_corner, 0);
    r.bindBuffer(r.ARRAY_BUFFER, this.iconBuf);
    r.bufferData(r.ARRAY_BUFFER, inst, r.DYNAMIC_DRAW);
    r.enableVertexAttribArray(g.a.a_inst);
    r.vertexAttribPointer(g.a.a_inst, 4, r.FLOAT, false, 16, 0);
    ext.vertexAttribDivisorANGLE(g.a.a_inst, 1);
    ext.drawArraysInstancedANGLE(r.TRIANGLES, 0, 6, n);
    this.countDraw(1);
    ext.vertexAttribDivisorANGLE(g.a.a_inst, 0);
    r.disableVertexAttribArray(g.a.a_corner);
    r.disableVertexAttribArray(g.a.a_inst);
    // 逐项还原
    r.bindTexture(r.TEXTURE_2D, prevTex);
    r.activeTexture(saved.unit);
    r.blendFuncSeparate(...saved.blend);
    if (!saved.blendOn) r.disable(r.BLEND);
    r.useProgram(saved.prog);
    r.bindBuffer(r.ARRAY_BUFFER, saved.buf);
    if (vaoExt) vaoExt.bindVertexArrayOES(saved.vao);
  }

  onFrame(gl, ctx) {
    const glx = this.glx;
    const t = performance.now() / 1000;
    if (this._pending) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this._pending, gl.STATIC_DRAW);
      this.segCount = this._pending.length / 6;
      this._pending = null;
    }
    if (this.segCount) {
      const g = this.lineProg;
      gl.useProgram(g.p);
      gl.uniformMatrix4fv(g.u.u_mvpMatrix, false, ctx.getMVPMatrix());
      gl.uniform1f(g.u.u_mpp, ctx.getUnitsPerPixel());
      gl.uniform1f(g.u.u_widthPx, 18);
      gl.uniform1f(g.u.u_pos, this.pos);
      gl.uniform1f(g.u.u_ahead, this.ahead);
      gl.uniform1f(g.u.u_time, t);
      const fire = this.kind === 'fire';
      gl.uniform1f(g.u.u_tail, ((this.units || 1) - 1) * (this.gap || 0));
      gl.uniform1f(g.u.u_trail, (fire ? 520 : 380) * 1.25);          // 拖尾约 520 m / 380 m
      gl.uniform3f(g.u.u_trailColor, ...(fire ? [1.0, 0.62, 0.22] : [1.0, 0.55, 0.6]));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
      gl.enableVertexAttribArray(g.a.a_corner);
      gl.vertexAttribPointer(g.a.a_corner, 2, gl.FLOAT, false, 0, 0);
      glx.divisor(g.a.a_corner, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
      gl.enableVertexAttribArray(g.a.a_ab);
      gl.vertexAttribPointer(g.a.a_ab, 4, gl.FLOAT, false, 24, 0);
      glx.divisor(g.a.a_ab, 1);
      gl.enableVertexAttribArray(g.a.a_cum);
      gl.vertexAttribPointer(g.a.a_cum, 2, gl.FLOAT, false, 24, 16);
      glx.divisor(g.a.a_cum, 1);
      glx.drawInstanced(gl.TRIANGLES, this.segCount, 6, 0);
      this.countDraw(1);
      if (this._dbg && !this._dbgSent && performance.now() - this._dbg > 12000) this._debugProbe(gl, ctx);
      for (const l of [g.a.a_corner, g.a.a_ab, g.a.a_cum]) { glx.divisor(l, 0); gl.disableVertexAttribArray(l); }
    }
    if (this.amb) this._extrapolate();
    if (this.amb && this.pts) {
      const units = this._units();
      if (units.length) {
        const g = this.dotProg;
        gl.useProgram(g.p);
        gl.uniformMatrix4fv(g.u.u_mvpMatrix, false, ctx.getMVPMatrix());
        gl.uniform1f(g.u.u_dpr, ctx.getPixelRatio());
        gl.uniform1f(g.u.u_time, t);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.dotBuf);
        gl.bufferData(gl.ARRAY_BUFFER, units, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(g.a.a_p);
        gl.vertexAttribPointer(g.a.a_p, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(g.a.a_meta);
        gl.vertexAttribPointer(g.a.a_meta, 2, gl.FLOAT, false, 16, 8);
        gl.drawArrays(gl.POINTS, 0, units.length / 4);
        gl.disableVertexAttribArray(g.a.a_p);
        gl.disableVertexAttribArray(g.a.a_meta);
        this.countDraw(1);
        this._drawIcons(gl, ctx, units, t);    // 光圈打底，车辆图标叠在上面
      }
    }
  }
}
