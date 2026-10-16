/**
 * 内置性能测试：在真实浏览器里跑一整套脚本化场景，采集赛题要求的全部指标。
 *
 * 用法：打开 /?bench=1&fleet=1000000 ，测试自动执行，结束后屏幕中央弹出结果面板，可下载 JSON / Markdown。
 *
 * 指标口径（与赛题一一对应）：
 *   首屏数据展示时间  —— 从导航开始到第一条路网线段 / 第一辆车 / 第一个区域面上屏
 *   数据持续加载速度  —— 已接入字节 ÷ 耗时（MB/s），以及要素/秒
 *   数据增量渲染效率  —— 每帧上传字节、上传耗时、上传期间帧时间
 *   最大支持渲染规模  —— 分档测试（由多次运行的 fleet 参数给出），记录稳态 FPS ≥ 30 的最大档
 *   交互 FPS          —— 脚本驱动平移 / 缩放 / 旋转 / 倾斜，统计 FPS 均值与 P1/P5 低帧
 *   加载 FPS          —— 加载阶段的帧时间分布
 *   CPU 使用率        —— 主线程忙碌占比（长任务 + 帧内脚本），Worker 仿真占比（Worker 自报）
 *   GPU 使用率        —— EXT_disjoint_timer_query 测得的本项目图层 GPU 耗时 ÷ 帧预算
 *   内存占用          —— JS 堆（performance.memory）+ 显存账（我们分配的缓冲区字节数）
 */

const now = () => performance.now();

function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}

function summarizeFrames(frames) {
  // frames: 帧间隔（ms）
  if (!frames.length) return null;
  const fps = frames.map((d) => 1000 / d);
  const avgMs = frames.reduce((a, b) => a + b, 0) / frames.length;
  return {
    frames: frames.length,
    avgFps: +(1000 / avgMs).toFixed(1),
    p50Ms: +percentile(frames, 50).toFixed(2),
    p95Ms: +percentile(frames, 95).toFixed(2),
    p99Ms: +percentile(frames, 99).toFixed(2),
    maxMs: +Math.max(...frames).toFixed(1),
    low1Fps: +(1000 / percentile(frames, 99)).toFixed(1),     // 1% low
    jank: frames.filter((d) => d > 50).length,                  // 超过 50 ms 的卡顿帧数
    over33: frames.filter((d) => d > 33.4).length,
    minFps: +Math.min(...fps).toFixed(1),
  };
}

export class Bench {
  constructor({ map, layers, state, fleet, params }) {
    this.map = map;
    this.layers = layers;
    this.state = state;
    this.fleet = fleet;
    this.params = params;
    this.frames = [];          // 当前阶段的帧间隔
    this.longTasks = [];
    this.phase = 'idle';
    this.result = {
      meta: {
        ua: navigator.userAgent,
        cores: navigator.hardwareConcurrency,
        dpr: devicePixelRatio,
        viewport: [innerWidth, innerHeight],
        fleet: params.fleet,
        workers: params.workers || 'auto',
        uploadBudgetMs: params.uploadBudgetMs,
        kernel: params.wasm ? 'wasm' : 'js',
        when: new Date().toISOString(),
      },
      phases: {},
    };
    this._observeLongTasks();
    this._gpuInfo();
  }

  _gpuInfo() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      this.result.meta.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch { /* 忽略 */ }
  }

  _observeLongTasks() {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.longTasks.push({ t: e.startTime, d: e.duration, phase: this.phase });
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* Safari 不支持 */ }
  }

  /** 帧回调：由主循环每帧调用 */
  onFrame(dt) {
    if (this.phase !== 'idle' && dt > 0 && dt < 5000) this.frames.push(dt);
    // GPU 计时累积
    const v = this.layers.vehicleLayer;
    if (v?.stats.gpuMs != null) (this._gpu ||= []).push(v.stats.gpuMs);
    // 本项目各图层在主线程上的耗时（onRender 内，含 GL 命令提交），与 ?fpsdl 同一口径
    if (this.phase !== 'idle') this._cpu.push(Object.values(this.layers).reduce((s, L) => s + (L?.stats?.drawMs || 0), 0));
  }

  _mem() {
    const m = performance.memory;
    const vram = Object.values(this.layers).reduce((s, L) => s + (L?.vramBytes || 0), 0);
    return {
      jsHeapMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null,
      jsHeapLimitMB: m ? +(m.jsHeapSizeLimit / 1048576).toFixed(0) : null,
      gpuBuffersMB: +(vram / 1048576).toFixed(1),
    };
  }

  /** 进入一个阶段：清空帧样本，开始计时 */
  begin(name) {
    this.phase = name;
    this.frames = [];
    this._gpu = [];
    this._cpu = [];
    this._ltStart = this.longTasks.length;
    this._t0 = now();
    this._scriptStart = this.state.workerStepMs || 0;
    // 增量渲染：记下快照上传字节与换页次数，阶段结束时求差
    const vs = this.layers.vehicleLayer?.stats || {};
    this._vl0 = { up: vs.totalUploadBytes || 0, sw: vs.swaps || 0 };
    this.onPhase?.(name);       // 给 ?debug=1 的演示进度条用
  }

  end(extra = {}) {
    const dur = now() - this._t0;
    const lts = this.longTasks.slice(this._ltStart);
    const ltSum = lts.reduce((s, x) => s + x.d, 0);
    const frameStats = summarizeFrames(this.frames);
    const gpu = this._gpu.filter((x) => x != null);
    const gpuAvg = gpu.length ? gpu.reduce((a, b) => a + b, 0) / gpu.length : null;
    // 增量渲染效率：本阶段快照上传速率，以及每个 Worker 分片每秒换页次数（数据新鲜度，理想 1 Hz）
    const VL = this.layers.vehicleLayer;
    const sec = dur / 1000;
    const parts = VL?.parts?.filter((p) => p.filled).length || 0;
    const cpuAvg = this._cpu.length ? this._cpu.reduce((a, b) => a + b, 0) / this._cpu.length : null;
    this.result.phases[this.phase] = {
      durationMs: Math.round(dur),
      ...frameStats,
      longTasks: lts.length,
      longTaskMs: Math.round(ltSum),
      // 主线程忙碌占比的保守估计：长任务时间 + 平均帧内本项目耗时
      mainThreadBusyPct: +((100 * ltSum) / dur).toFixed(1),
      gpuMsAvg: gpuAvg != null ? +gpuAvg.toFixed(2) : null,
      gpuUtilPct: gpuAvg != null && frameStats ? +((100 * gpuAvg) / (1000 / frameStats.avgFps)).toFixed(1) : null,
      ourCpuMs: cpuAvg != null ? +cpuAvg.toFixed(2) : null,
      uploadMBps: VL ? +((((VL.stats.totalUploadBytes || 0) - this._vl0.up) / 1048576) / sec).toFixed(1) : null,
      snapHz: VL && parts ? +(((VL.stats.swaps || 0) - this._vl0.sw) / sec / parts).toFixed(2) : null,
      lodK: VL?.stats.lodK ?? null,
      mem: this._mem(),
      ...extra,
    };
    this.phase = 'idle';
    return this.result.phases[this.phase];
  }

  wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** 脚本化交互：平移、缩放、旋转、倾斜 */
  async interact(kind, ms) {
    const map = this.map;
    const t0 = now();
    const c0 = map.getCenter();
    const z0 = map.getZoom();
    return new Promise((resolve) => {
      const step = () => {
        const t = (now() - t0) / ms;
        if (t >= 1) return resolve();
        const s = Math.sin(t * Math.PI * 2);
        if (kind === 'pan') {
          map.setCenter(new BMap.Point(c0.lng + s * 3.0 * Math.pow(2, 5 - z0), c0.lat + Math.cos(t * Math.PI * 2) * 1.5 * Math.pow(2, 5 - z0)), { noAnimation: true });
        } else if (kind === 'zoom') {
          map.setZoom(z0 + s * 2.2, { noAnimation: true });
        } else if (kind === 'rotate') {
          map.setHeading(t * 360);
        } else if (kind === 'tilt') {
          map.setTilt(Math.abs(s) * 60);
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  /** 完整测试流程 */
  async run() {
    const S = this.state;
    const L = this.layers;
    const fleet = this.fleet;

    // 1) 加载阶段：从启动到「全部车辆上屏 + 路网加载完」或 60 s 超时
    this.begin('loading');
    const loadT0 = now();
    const bytes0 = S.bytes || 0;
    let fullAt = 0;
    while (now() - loadT0 < 60000) {
      await this.wait(250);
      const cars = L.vehicleLayer?.totalCount || 0;
      const linesDone = !L.roadLayer || (S.linesDone && L.roadLayer.pending === 0);
      if (cars >= this.params.fleet * 0.999 && linesDone && S.zonesDone !== false) { fullAt = now(); break; }
    }
    const loadDur = (fullAt || now()) - loadT0;
    this.end({
      firstLineMs: Math.round(S.tFirstLine || 0),
      firstCarMs: Math.round(S.tFirstCar || 0),
      firstZoneMs: Math.round(S.tFirstZone || 0),
      mapReadyMs: Math.round(S.tMapReady || 0),
      allLoadedMs: fullAt ? Math.round(fullAt - (S.tStream0 || loadT0)) : null,
      bytesMB: +(((S.bytes || 0) - bytes0) / 1048576).toFixed(1),
      throughputMBs: +((((S.bytes || 0) - bytes0) / 1048576) / (loadDur / 1000)).toFixed(2),
      carsLoaded: L.vehicleLayer?.totalCount || 0,
      carsPerSec: Math.round((L.vehicleLayer?.totalCount || 0) / (loadDur / 1000)),
      roadSegments: L.roadLayer?.segments || 0,
      zoneVertices: L.zoneLayer?.fillCount || 0,
      timedOut: !fullAt,
    });

    // 2) 稳态：静止 8 秒
    await this.wait(1500);
    this.begin('steady');
    await this.wait(8000);
    this.end({ visibleFeatures: S.visible, drawCalls: S.draws });

    // 3) 交互：平移 / 缩放 / 旋转 / 倾斜各 6 秒
    for (const k of ['pan', 'zoom', 'rotate', 'tilt']) {
      this.begin(`interact_${k}`);
      await this.interact(k, 6000);
      this.end({ drawCalls: S.draws });
      this.map.setHeading(0);
      this.map.setTilt(0);
      await this.wait(500);
    }

    // 4) 城市级近景（视锥剔除生效）
    this.map.centerAndZoom(new BMap.Point(116.404, 39.915), 13);
    await this.wait(2500);
    this.begin('city_zoom13');
    await this.interact('pan', 6000);
    this.end({ visibleFeatures: S.visible, drawCalls: S.draws });

    // 5) Worker 仿真占用（Worker 自报每秒推进耗时）
    this.result.workers = {
      count: fleet?.workers?.length || 0,
      stepMsPerSec: fleet ? +fleet.avgStepMs().toFixed(2) : null,
      cpuPctPerWorker: fleet ? +(fleet.avgStepMs() / 10).toFixed(2) : null,
    };
    this.result.memEnd = this._mem();
    return this.result;
  }
}

/** 结果 → Markdown（性能报告里直接引用） */
export function toMarkdown(r) {
  const P = r.phases;
  const row = (name, p) => {
    if (!p) return '';
    const up = p.uploadMBps != null ? p.uploadMBps : '-';
    const snap = p.snapHz != null ? p.snapHz : '-';
    const lod = p.lodK != null ? p.lodK : '-';
    const cpu = p.ourCpuMs != null ? p.ourCpuMs : '-';
    return `| ${name} | ${p.avgFps} | ${p.low1Fps} | ${p.p95Ms} | ${p.maxMs} | ${p.jank} | ${p.longTasks} | ${p.mainThreadBusyPct}% | ${p.gpuMsAvg ?? '-'} | ${cpu} | ${up} | ${snap} | ${lod} | ${p.mem?.jsHeapMB ?? '-'} |`;
  };
  const ld = P.loading || {};
  return `# Apollo 2035 性能测试结果

- 时间：${r.meta.when}
- 浏览器：${r.meta.ua}
- GPU：${r.meta.gpu}${/Safari\/605/.test(r.meta.ua) ? '（Safari 不支持 GPU 计时查询，GPU 列为 -）' : ''}
- CPU 核数：${r.meta.cores}；DPR：${r.meta.dpr}；视口：${r.meta.viewport.join('×')}
- 车辆规模：${r.meta.fleet.toLocaleString()}；仿真 Worker：${r.workers?.count}（内核 ${r.meta.kernel?.toUpperCase()}）；上传预算：${r.meta.uploadBudgetMs} ms/帧

## 加载阶段

| 指标 | 数值 |
|---|---|
| 地图引擎就绪 | ${ld.mapReadyMs} ms |
| 首条路网上屏 | ${ld.firstLineMs} ms |
| 首辆车上屏 | ${ld.firstCarMs} ms |
| 全部加载完成 | ${ld.timedOut ? '超过 60 s（未完成）' : ld.allLoadedMs + ' ms'} |
| 接入数据量 | ${ld.bytesMB} MB |
| 持续加载速度 | ${ld.throughputMBs} MB/s，${(ld.carsPerSec || 0).toLocaleString()} 辆/s |
| 车辆 / 路网线段 / 面顶点 | ${(ld.carsLoaded || 0).toLocaleString()} / ${(ld.roadSegments || 0).toLocaleString()} / ${(ld.zoneVertices || 0).toLocaleString()} |

## 帧率

| 阶段 | 平均 FPS | 1% Low | P95 帧时(ms) | 最长帧(ms) | 卡顿帧(>50ms) | 长任务 | 主线程忙碌 | GPU ms/帧 | 本项目 CPU ms | 上传 MB/s | 快照新鲜度 Hz | LOD K | JS 堆(MB) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${row('数据加载中', P.loading)}
${row('稳态（静止）', P.steady)}
${row('交互：平移', P.interact_pan)}
${row('交互：缩放', P.interact_zoom)}
${row('交互：旋转', P.interact_rotate)}
${row('交互：倾斜', P.interact_tilt)}
${row('城市近景 z13', P.city_zoom13)}

## 资源

- Worker 仿真：每 Worker 每秒推进耗时 ${r.workers?.stepMsPerSec} ms（≈ ${r.workers?.cpuPctPerWorker}% 单核）
- 显存（本项目分配的缓冲区）：${r.memEnd?.gpuBuffersMB} MB
- JS 堆：${r.memEnd?.jsHeapMB != null ? r.memEnd.jsHeapMB + ' MB' : '浏览器不提供（Safari 无 performance.memory）'}
`;
}
