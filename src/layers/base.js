/**
 * 图层基类：基于百度地图 JSAPI 4.0 的 WebGLCustomLayer（WebGLLayer 体系）。
 *
 * 选择「安全模式」（unsafeGL: false）的原因（均为实测结论，见 docs/00-平台实测.md）：
 *  - 在 unsafeGL 模式下改动 framebuffer / viewport，会把底图整帧擦掉；
 *  - 安全模式由框架统一保存/恢复 GL 状态，并重置底图 painter 的 program 缓存，不污染底图；
 *  - 安全模式仍允许我们自建缓冲区、bufferSubData 增量上传、实例化绘制 ——
 *    海量数据渲染需要的能力全部可用。
 *  - 混合方式（叠加/普通）通过官方 renderState 配置，不直接调 gl.enable/blendFunc。
 */

// 注意：占位着色器必须真正使用 u_mvpMatrix。
// 框架只在「图层程序含有 u_mvpMatrix 这个活跃 uniform」时才把 MVP 写进 ctx.getMVPMatrix()，
// 否则 ctx.getMVPMatrix() 恒为全零 → 所有顶点塌缩到一点、画面空无一物（实测踩坑）。
const DUMMY_VS = 'attribute vec2 a_dummy; uniform mat4 u_mvpMatrix; void main(){ gl_Position = u_mvpMatrix * vec4(a_dummy, 0.0, 1.0); }';
const DUMMY_FS = 'precision mediump float; void main(){ gl_FragColor = vec4(0.0); }';

export class BaseLayer {
  constructor(o = {}) {
    this.opts = o;
    this.gl = null;
    this.layer = null;
    this.visible = o.visible !== false;
    this.stats = { drawMs: 0, gpuMs: null, prims: 0, draws: 0, uploadMs: 0 };
  }

  /** 子类实现：GL 就绪后初始化（编译着色器、建缓冲） */
  onInit() {}

  /** 子类实现：每帧绘制 */
  onFrame() {}

  mount(map) {
    const self = this;
    this.map = map;
    const layer = new BMap.WebGLCustomLayer({
      vertexShader: DUMMY_VS,
      fragmentShader: DUMMY_FS,
      attributes: { a_dummy: { type: 'Float32', data: new Float32Array([0, 0]), components: 2 } },
      animation: true,                       // 持续重绘：动态数据需要
      zIndex: this.opts.zIndex ?? 10,
      renderState: {
        // ?blend=normal 可强制普通混合：浅色底图下叠加混合会饱和成白色，调试时用
        blend: new URLSearchParams(location.search).get('blend') || this.opts.blend || 'normal',
        depthTest: !!this.opts.depth,        // 3D 柱体需要深度测试
        depthWrite: !!this.opts.depth,
      },
      onRender(ctx) {
        const gl = ctx.gl;
        if (!self.gl) {
          self.gl = gl;
          self.ctx = ctx;
          self.layerRef = layer;
          self.onInit(gl, map, ctx);
        }
        if (!self.visible) return;
        const t0 = performance.now();
        self.stats.draws = 0;
        self.stats.prims = 0;
        // 关键：框架的安全模式只还原它自己的「状态缓存」，不会把真实的
        // ARRAY_BUFFER / 程序 / VAO 绑定改回去。底图渲染器依赖这些缓存跳过重复绑定，
        // 如果我们改了真实绑定却不还原，底图下一帧会读到我们的缓冲区 → 整屏空白（实测）。
        // 所以每帧前后保存/还原这几项真实绑定（都是客户端状态查询，不会造成 GPU 同步）。
        const saved = self._saveBindings(gl);
        try {
          self.onFrame(gl, ctx);
        } finally {
          self._restoreBindings(gl, saved);
        }
        self.stats.drawMs = performance.now() - t0;
      },
      onDestroy() { self.onDispose?.(); },
      onError(e) { console.error('[layer]', self.constructor.name, e && (e.message || e)); },
    });
    this.layer = layer;
    map.addLayer(layer);
    return layer;
  }

  _saveBindings(gl) {
    const vaoExt = this._vaoExt || (this._vaoExt = gl.getExtension('OES_vertex_array_object'));
    return {
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
      elementBuffer: gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING),
      vao: vaoExt ? gl.getParameter(vaoExt.VERTEX_ARRAY_BINDING_OES) : null,
      activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
    };
  }

  _restoreBindings(gl, s) {
    const vaoExt = this._vaoExt;
    if (vaoExt) vaoExt.bindVertexArrayOES(s.vao);
    gl.useProgram(s.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.arrayBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.elementBuffer);
    gl.activeTexture(s.activeTexture);
  }

  setBlend(mode) {
    const forced = new URLSearchParams(location.search).get('blend');
    this.layer?.setRenderState?.({ blend: forced || mode, depthTest: !!this.opts.depth, depthWrite: !!this.opts.depth });
  }

  setVisible(v) {
    this.visible = !!v;
  }

  /** 累加本帧 Draw Call 计数（子类在每个 draw 调用后记一次） */
  countDraw(n = 1) { this.stats.draws += n; }
}
