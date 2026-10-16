/**
 * WebGL1 扩展封装与着色器工具。
 * JSAPI 的 WebGLLayer 给的是 WebGL1 上下文（实测），
 * 实例化绘制要靠 ANGLE_instanced_arrays 扩展。
 */

export class GLX {
  constructor(gl) {
    this.gl = gl;
    this.inst = gl.getExtension('ANGLE_instanced_arrays');
    this.vao = gl.getExtension('OES_vertex_array_object');
    this.uint = gl.getExtension('OES_element_index_uint');
    this.timer = gl.getExtension('EXT_disjoint_timer_query');
    if (!this.inst) console.warn('[gl] 缺少 ANGLE_instanced_arrays，实例化绘制不可用');
  }

  /** 一条实例化绘制；n 为实例数，attrCount 为每实例顶点数（默认 1 个点） */
  drawInstanced(mode, n, count = 1, first = 0) {
    if (!this.inst) { this.gl.drawArrays(mode, first, count); return; }
    this.inst.drawArraysInstancedANGLE(mode, first, count, n);
  }

  divisor(loc, d) {
    if (this.inst && loc >= 0) this.inst.vertexAttribDivisorANGLE(loc, d);
  }

  createVAO() { return this.vao ? this.vao.createVertexArrayOES() : null; }
  bindVAO(v) { if (this.vao) this.vao.bindVertexArrayOES(v); }
  deleteVAO(v) { if (this.vao && v) this.vao.deleteVertexArrayOES(v); }

  /* ---------- GPU 计时（EXT_disjoint_timer_query） ---------- */
  beginTimer() {
    if (!this.timer) return null;
    // 同一时刻只允许一个活动查询，先回收未读的
    if (this._pending) this.pollTimer();
    this._query = this.timer.createQueryEXT();
    this.timer.beginQueryEXT(this.timer.TIME_ELAPSED_EXT, this._query);
    return this._query;
  }

  endTimer() {
    if (!this.timer || !this._query) return;
    this.timer.endQueryEXT(this.timer.TIME_ELAPSED_EXT);
    this._pending = this._query;
    this._query = null;
  }

  /** 返回最近一次可用结果（毫秒），无结果返回 null */
  pollTimer() {
    if (!this.timer || !this._pending) return this._lastMs ?? null;
    const avail = this.timer.getQueryObjectEXT(this._pending, this.timer.QUERY_RESULT_AVAILABLE_EXT);
    const disjoint = this.gl.getParameter(this.timer.GPU_DISJOINT_EXT);
    if (avail && !disjoint) {
      this._lastMs = this.timer.getQueryObjectEXT(this._pending, this.timer.QUERY_RESULT_EXT) / 1e6;
      this.timer.deleteQueryEXT(this._pending);
      this._pending = null;
      return this._lastMs;
    }
    if (disjoint) { this.timer.deleteQueryEXT(this._pending); this._pending = null; }
    return this._lastMs ?? null;
  }

  get lastGpuMs() { return this._lastMs ?? null; }
}

/** 编译着色器，失败时抛出带行号的日志 */
export function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
    gl.deleteShader(sh);
    throw new Error(`着色器编译失败: ${log}\n${numbered}`);
  }
  return sh;
}

/** 链接程序并缓存 uniform / attribute 位置 */
export function program(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  const u = {};
  const a = {};
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, name);
  }
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) {
    const info = gl.getActiveAttrib(p, i);
    a[info.name] = gl.getAttribLocation(p, info.name);
  }
  return { p, u, a };
}

/** 创建或复用缓冲区，按需扩容（WebGL1 没有 buffer 拷贝，扩容只能重建） */
export function ensureBuffer(gl, buf, bytes, target = gl.ARRAY_BUFFER) {
  const cur = buf ? gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE) : 0;
  if (!buf || cur < bytes) {
    if (buf) gl.deleteBuffer(buf);
    const nb = gl.createBuffer();
    gl.bindBuffer(target, nb);
    gl.bufferData(target, bytes, gl.DYNAMIC_DRAW);
    return nb;
  }
  return buf;
}
