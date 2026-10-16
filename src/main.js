/**
 * Apollo 2035 · 全国无人驾驶出行运营中枢
 * 基于百度地图 JSAPI 4.0 WebGLLayer 的海量空间数据流式高性能渲染
 *
 * 三条数据链路，全部流式、全部异步：
 *   面：zones.ndjson ──Worker(解析+earcut 三角化)──► 增量上显存 ──► 区域着色
 *   线：lines-*.bin  ──按视野优先级逐城拉取────────► 增量上显存 ──► 路网 + 流动光效
 *   点：city-*.bin   ──仿真 Worker 逐城生成车辆────► 每秒快照 ──► 顶点着色器插值 ──► 实例化绘制
 */
import { loadBMap, createMap } from './map/baidu.js';
import { VehicleLayer } from './layers/vehicle.js';
import { RoadLayer } from './layers/road.js';
import { ZoneLayer } from './layers/zone.js';
import { HexLayer } from './layers/hex.js';
import { EventLayer } from './layers/event.js';
import { CityGlowLayer } from './layers/glow.js';
import { FlowLayer } from './layers/flow.js';
import { SnapLayer } from './layers/snap.js';
import { rel2ll } from './core/projection.js';
import { Fleet } from './sim/fleet.js';
import { LineFeed } from './stream/lineFeed.js';
import { ZoneFeed } from './stream/zoneFeed.js';
import { Hud } from './ui/hud.js';
import { CityLabels } from './ui/cityLabels.js';
import { Bench, toMarkdown } from './bench/bench.js';
import { saveResult, browserTag } from './bench/save.js';

const Q = new URLSearchParams(location.search);
const params = {
  fleet: Number(Q.get('fleet') || 1_000_000),
  workers: Number(Q.get('workers') || 0) || undefined,
  uploadBudgetMs: Number(Q.get('ub') || 2.5),
  zoom: Number(Q.get('zoom') || 5),
  center: (Q.get('center') || '108.9,34.2').split(',').map(Number),
  autostart: Q.get('start') !== '0',
  roads: Q.get('roads') !== '0',
  zones: Q.get('zones') !== '0',
  // ?bench=1：内置性能测试（严格测量模式，镜头全程由脚本驱动，用于比赛性能参数）
  bench: Q.get('bench') === '1',
  // ?debug=1：演示模式 —— 显示帧率面板，并自动播放四幕（平滑运镜）。
  // 画面上一动鼠标 / 滚轮 / 点击，演示立刻让位，随时可以自己操作
  demo: Q.get('debug') === '1' || Q.get('debug') === 'true',
  wasm: Q.get('wasm') !== '0',
  // ?showcity=0/1：城市光晕下方的城市名。默认开；性能测试 / 帧率探针默认关，保持测量条件与报告一致
  showCity: Q.has('showcity') ? Q.get('showcity') !== '0' : !(Q.get('bench') === '1' || Q.has('fpsdl')),
  // 纯渲染压力测试：一次性生成 N 辆静态车辆（不启动仿真），用于测「最大支持渲染规模」
  stress: Number(Q.get('stress') || 0),
};

const hud = new Hud();
const state = {
  cars: 0, features: 0, bytes: 0, rate: 0, draws: 0,
  uploadMs: 0, gpuMs: null, frames: 0, simMs: 0,
  // 首屏指标：从页面开始到「第一辆车/第一条线」出现
  t0: performance.now(), tFirstCar: 0, tFirstLine: 0, tFirstZone: 0,
};
window.__state = state;

async function boot() {
  hud.setStatus('加载地图引擎…');
  const tMap0 = performance.now();
  await loadBMap(import.meta.env.VITE_BAIDU_AK);
  const map = createMap('map', { center: params.center, zoom: params.zoom, style: Q.get('style') !== '0' });
  window.__map = map;
  window.__rel2ll = (x, y) => rel2ll(x, y, [0, 0]);   // 测试脚本用：图层坐标 → 经纬度
  // WebGL 上下文丢失监测：显存吃紧时浏览器会回收上下文，必须能感知
  const watchCanvas = () => {
    const cv = document.querySelector('#map canvas');
    if (!cv) return setTimeout(watchCanvas, 300);
    cv.addEventListener('webglcontextlost', (e) => {
      state.contextLost = (state.contextLost || 0) + 1;
      console.error('[gl] WebGL 上下文丢失', new Date().toISOString());
    });
    cv.addEventListener('webglcontextrestored', () => console.warn('[gl] WebGL 上下文已恢复'));
  };
  watchCanvas();
  state.tMapReady = performance.now() - tMap0;

  const [cities, packs] = await Promise.all([
    fetch('/data/cities.json').then((r) => r.json()),
    fetch('/data/packs.json').then((r) => r.json()),
  ]);
  state.tCities = performance.now() - tMap0;
  console.log(`[data] ${cities.length} 城市（真实路网 ${cities.filter((c) => c.real).length}），权重合计 ${cities.reduce((s, c) => s + c.weight, 0)}`);

  /* ---------------- 图层：面 / 线 / 点（zIndex 决定叠放次序） ---------------- */
  const zoneLayer = params.zones ? new ZoneLayer({ alpha: 0.42, extrude: 0.0, zIndex: 6 }) : null;
  const roadLayer = params.roads ? new RoadLayer({ widthGain: 2.2, minPx: 0.8, alpha: 0.75, flow: 0.7, zIndex: 12 }) : null;
  const vehicleLayer = new VehicleLayer({ capacity: params.fleet, uploadBudgetMs: params.uploadBudgetMs, lod: Q.get('lod') !== '0', orphan: Q.get('orphan') === '1' });
  // ?gputimer=0：关闭 GPU 计时查询（对照：查询本身是否带来主线程同步开销）
  if (Q.get('gputimer') === '0') vehicleLayer.gpuTiming = false;
  const hexLayer = new HexLayer({ visible: false });
  const eventLayer = new EventLayer();
  // 全国视角的聚合层级：城市光晕 + 城际流线（放大后自动淡出）
  const glowLayer = Q.get('glow') !== '0' ? new CityGlowLayer({ cities }) : null;
  const flowLayer = Q.get('flow') !== '0' ? new FlowLayer({ cities }) : null;
  zoneLayer?.mount(map);
  flowLayer?.mount(map);
  roadLayer?.mount(map);
  hexLayer.mount(map);
  glowLayer?.mount(map);
  vehicleLayer.mount(map);
  eventLayer.mount(map);
  window.__layers = { zoneLayer, roadLayer, vehicleLayer, hexLayer, eventLayer, glowLayer, flowLayer };
  const cityLabels = params.showCity && glowLayer ? new CityLabels(map, cities) : null;
  // ?snap=名称@秒,…：定时读取 WebGL 帧缓冲存成 PNG（无需系统截屏权限）
  if (Q.get('snap')) {
    const snap = new SnapLayer();
    snap.mount(map);
    for (const item of Q.get('snap').split(',')) {
      const [name, sec] = item.split('@');
      setTimeout(() => snap.request(name), Number(sec || 5) * 1000);
    }
  }

  /* ---------------- 需求预测（第三幕）：Worker 计算，图层只更新几 KB ---------------- */
  let demandWorker = null;
  // city：{ id, center }；同一城市重复调用不重建网格
  const startDemand = (city = { id: 'beijing', center: [116.404, 39.93] }) => {
    if (demandWorker) {
      if (demandWorker.cityId !== city.id) { demandWorker.cityId = city.id; demandWorker.postMessage({ cmd: 'init', center: city.center, radiusKm: 24, cityId: city.id }); }
      return;
    }
    demandWorker = new Worker(new URL('./sim/demand.worker.js', import.meta.url), { type: 'module' });
    demandWorker.onmessage = (ev) => {
      const m = ev.data;
      if (m.t === 'grid') hexLayer.setGrid(new Float32Array(m.cells), m.radius);
      else if (m.t === 'values') hexLayer.setValues(new Float32Array(m.data));
    };
    demandWorker.cityId = city.id;
    demandWorker.postMessage({ cmd: 'init', center: city.center, radiusKm: 24, cityId: city.id });
  };

  /* ---------------- 流式数据源 ---------------- */
  const tStream0 = performance.now();
  state.tStream0 = tStream0;
  let zoneFeed = null, lineFeed = null;
  if (params.zones && zoneLayer) {
    state.zonesDone = false;
    zoneLayer.onFirstData = () => { if (!state.tFirstZone) state.tFirstZone = performance.now() - tStream0; };
    zoneFeed = new ZoneFeed({
      layer: zoneLayer,
      onEvent: (e) => {
        if (e.t === 'zonesDone') state.zonesDone = true;
        if (e.t === 'zonesDone') console.log(`[zones] ${e.features} 个面，三角化 ${e.ms.toFixed(0)}ms，${(e.fill / 3).toFixed(0)} 三角形`);
      },
    }).start();
  }
  if (params.roads && roadLayer) {
    lineFeed = new LineFeed({
      layer: roadLayer,
      packs: packs.lines,
      cities,
      onEvent: (e) => {
        if (e.t === 'line' && !state.tFirstLine) state.tFirstLine = performance.now() - tStream0;
        if (e.t === 'linesDone') state.linesDone = true;
        if (e.t === 'linesDone') console.log(`[lines] ${e.cities} 城，${e.segments.toLocaleString()} 线段，${(e.bytes / 1048576).toFixed(1)} MB，${(e.ms / 1000).toFixed(1)}s`);
      },
    });
    lineFeed.prioritize(params.center);
    lineFeed.start();
  }

  /* ---------------- 车流 ---------------- */
  let fleet = null;
  const startFleet = (fleetSize) => {
    hud.setStatus('接入全国车流…');
    fleet = new Fleet({
      layer: vehicleLayer,
      cities,
      packs: packs.routes,
      total: fleetSize,
      wasm: params.wasm,
      workers: params.workers,
      baseUrl: '/data/',
      onEvent: (e) => {
        if (e.t === 'ready') {
          console.log(`[fleet ${e.worker}] ${e.n.toLocaleString()} 辆就绪，${e.cities} 城市，内核 ${e.wasm ? 'WASM' : 'JS'}`);
          hud.setStatus('实时运营中');
        }
        if (e.t === 'corridor') {
          if (e.on) {
            const pts = new Float32Array(e.pts);
            eventLayer.setCorridor(pts, new Float32Array(e.cum), { kind: e.kind, units: e.units, gap: e.gap });
            // 镜头：平滑飞到救护车起点、转到前进方向（通道朝屏幕里延伸），落定后再逐帧跟随
            const n = pts.length / 2;
            const dx = pts[(n - 1) * 2] - pts[0], dy = pts[(n - 1) * 2 + 1] - pts[1];
            // 百度 setHeading 逆时针为正：要取负，通道才朝屏幕正上方（里）延伸（实测；之前未取负，方向是偏的）
            const heading = (-Math.atan2(dx, dy) * 180) / Math.PI;
            const p0 = rel2ll(pts[0], pts[1], [0, 0]);
            state.follow = null;
            // 消防车队拉得更近（15.6 级）、倾斜小一些（透视会把车距压扁），一列车每辆都看得清；救护车单车 14.6 级
            flyCamera(map, { center: p0, zoom: e.kind === 'fire' ? 15.6 : 14.6, tilt: e.kind === 'fire' ? 50 : 62, heading }, 1800).then((done) => {
              // 飞行途中被别的幕或用户打断就不再接管镜头
              if (done && state.act === 'corridor' && eventLayer.amb) { state.follow = { heading }; state.camH = map.getHeading(); }
            });
          } else {
            eventLayer.clear();
            state.follow = null;
            toast(e.kind === 'fire' ? '消防车队已抵达 · 交通恢复' : '救护车已抵达 · 生命通道解除');
          }
        }
        if (e.t === 'ambulance') {
          eventLayer.setAmbulance(e.x, e.y, e.s);
          state.yielded = e.yielded;
        }
        if (e.t === 'snap' && demandWorker && e.tod != null) demandWorker.postMessage({ cmd: 'tod', tod: e.tod });
        if (e.t === 'city') {
          if (!state.tFirstCar) state.tFirstCar = performance.now() - tStream0;
          // 唯一城市计数：大城市数据被拆成多帧，同一座城会到达多次
          (state.citiesOn ||= new Set()).add(e.id);
          glowLayer?.markLoaded(e.id);          // 城市数据到达 → 光晕闪光点亮
          cityLabels?.markLoaded(e.id);         // 同时标出城市名
        }
        if (e.t === 'snap' && e.tod != null) glowLayer?.setTripShare(tripShareAt(e.tod));
      },
    });
    window.__fleet = fleet;
    state.citiesTotal = fleet.cities.length;    // 车队实际分到的城市数（入场进度条 / 覆盖城市）
    const timer = setInterval(() => {
      state.cars = vehicleLayer.totalCount;
      state.bytes = fleet.loadedBytes + (lineFeed?.bytes || 0);
      // 加载吞吐 = 已接入数据 / 实际传输时长（到最后一个字节到达为止）。数据传完即定格 ——
      // 若除以「至今的总时长」，加载结束后数字会一路衰减（几十秒后只剩 2 MB/s），和实测对不上
      const tEnd = Math.max(fleet.tLastByte || 0, lineFeed?.tLastByte || 0) || performance.now();
      state.rate = state.bytes / 1048576 / Math.max(0.05, (tEnd - tStream0) / 1000);
    }, 250);
    state.stopTimers = () => clearInterval(timer);
    return fleet;
  };

  /* ---------------- 帧循环：HUD + 性能采样 ---------------- */
  let bench = null;
  const ll = [0, 0];
  const tick = () => {
    hud.frame();
    // 生命通道：镜头逐帧跟随救护车（位置由事件图层按速度外推，平滑无跳变）
    if (state.follow && eventLayer.amb && state.act === 'corridor') {
      // 无人机视角：镜头看向车队前方、朝向跟着路线转弯；转向按时间指数平滑并限速，不猛甩
      const cam = eventLayer.chase();
      if (cam) {
        const now = performance.now();
        const dt = Math.min(0.1, (now - (state._camT || now)) / 1000);
        state._camT = now;
        let d = cam.heading - state.camH;
        d -= Math.round(d / 360) * 360;                 // 走最短的转向
        const step = d * (1 - Math.exp(-dt * 2.2));
        state.camH += Math.max(-30 * dt, Math.min(30 * dt, step));   // 转向封顶 30°/秒，急弯也是缓缓转过去
        rel2ll(cam.x, cam.y, ll);
        map.setCenter(new BMap.Point(ll[0], ll[1]), { noAnimation: true });
        if (Math.abs(map.getHeading() - state.camH) > 0.05) map.setHeading(state.camH, { noAnimation: true });
      }
    } else {
      state._camT = 0;
    }
    state.frames++;
    state.draws = Object.values(window.__layers).reduce((n, L) => n + (L?.visible !== false ? (L?.stats.draws || 0) : 0), 0);
    state.uploadMs = (vehicleLayer.stats.uploadMs || 0) + (roadLayer?.stats.uploadMs || 0);
    state.gpuMs = vehicleLayer.stats.gpuMs;
    state.visible = (zoneLayer?.stats.prims || 0) + (roadLayer?.stats.prims || 0) + vehicleLayer.visibleCount;
    // DOM 更新降到 4 Hz：每帧改文本会触发样式计算，白白占主线程
    if (performance.now() - (state._hudT || 0) > 250) {
      state._hudT = performance.now();
      hud.update({
      cars: state.cars,
      features: state.visible,
      bytes: state.bytes,
      rate: state.rate,
      draws: state.draws,
      uploadMs: state.uploadMs,
      gpuMs: state.gpuMs,
      zoom: map.getZoom(),
      });
    }
    if (bench) bench.onFrame(hud.frameMs);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  /* ---------------- 交互 ---------------- */
  document.getElementById('sp-enter').addEventListener('click', (ev) => {
    if (fleet) return dismissSplash();
    // ?start=0 时第一次点击：开始接入，入场层留下来展示接入进度
    startFleet(params.fleet);
    runSplash(params.fleet);
    document.getElementById('s-state').textContent = '正在接入全国车流';
    ev.currentTarget.textContent = '进入运营中枢';
  });

  if (params.stress > 0) {
    // 在城市中心附近按人口权重撒点，一次性推入图层（分帧上传仍走预算机制）
    const n = params.stress;
    const t0 = performance.now();
    const buf = new ArrayBuffer(n * 16);
    const f32 = new Float32Array(buf), u8 = new Uint8Array(buf);
    const ws = cities.map((c) => c.weight);
    const sum = ws.reduce((a, b) => a + b, 0);
    const cdf = []; let acc = 0; for (const w of ws) { acc += w / sum; cdf.push(acc); }
    const rel = [0, 0];
    const { ll2rel } = await import('./core/projection.js');
    for (let i = 0; i < n; i++) {
      const u = Math.random();
      let lo = 0, hi = cdf.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; }
      const c = cities[lo];
      const r = Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) * 0.06, a = Math.random() * Math.PI * 2;
      ll2rel(c.center[0] + Math.cos(a) * r, c.center[1] + Math.sin(a) * r * 0.8, rel);
      f32[i * 4] = rel[0]; f32[i * 4 + 1] = rel[1]; f32[i * 4 + 2] = a;
      u8[i * 16 + 12] = 40; u8[i * 16 + 13] = (Math.random() * 4) | 0; u8[i * 16 + 14] = 1; u8[i * 16 + 15] = 3;
    }
    vehicleLayer.capacity = n;
    vehicleLayer.addPart({ offset: 0, count: n });
    vehicleLayer.pushSnapshot(0, buf, []);
    state.stressGenMs = performance.now() - t0;
    console.log(`[stress] 生成 ${n.toLocaleString()} 辆，${state.stressGenMs.toFixed(0)} ms`);
    dismissSplash();
  } else if (params.autostart) {
    startFleet(params.fleet);
    runSplash(params.fleet);
  } else {
    // ?start=0：不自动接入，停在入场界面等待点击
    document.getElementById('s-state').textContent = '等待接入全国车流';
    document.getElementById('sp-enter').textContent = '接入全国车流';
  }

  // 演示分幕：切换视角、时间加速与潮汐方向
  const acts = {
    nation: { center: [108.9, 34.2], zoom: 5, tod: 450, scale: 1, tilt: 0 },
    // 城市潮汐：从清晨 5 点开始，1 秒 = 3 分钟，约 1 分钟看完早高峰。城市可选（city 级）
    tide: { city: true, zoom: 11, tod: 300, scale: 180, tilt: 0 },
    // 网约车需求预测：北京热点按真实地点建模，其它城市按城市结构生成。城市可选
    demand: { city: true, zoom: 11.6, tod: 470, scale: 30, tilt: 55, heading: 20 },
    // 生命通道：仿真加速 10×，约 1 分钟看完救护车穿城。城市可选
    corridor: { city: true, zoom: 13.5, tod: 600, scale: 10, tilt: 50 },
  };
  // 生命通道的事件种类（第四幕二级菜单上面一行切换；?event=fire|ambulance）
  const EVENTS = {
    ambulance: { code: '120', icon: '🚑', label: '120 救护车', toast: (c) => `120 急救调度 · ${c} · 前方车辆自动让行` },
    fire: { code: '119', icon: '🚒', label: '119 消防车队', toast: (c) => `119 火警 · ${c} · 警车开道，消防车队穿城，沿途车辆让行` },
  };
  state.event = EVENTS[Q.get('event')] ? Q.get('event') : 'ambulance';
  // 可选城市：只列有 OSM 真实路网的 8 座（合成路网放大到城市级会露馅）
  const realCities = ['beijing', 'shanghai', 'hangzhou', 'guangzhou', 'shenzhen', 'chongqing', 'wuhan', 'chengdu']
    .map((id) => cities.find((c) => c.id === id)).filter(Boolean);
  const cityName = (c) => c.name.replace(/市$/, '');
  const pickCity = (id) => (id === 'random' || !id)
    ? realCities[Math.floor(Math.random() * realCities.length)]
    : (realCities.find((c) => c.id === id) || realCities[0]);
  state.city = { tide: realCities[0], demand: realCities[0], corridor: realCities[0] };

  /** 进入某一幕；城市级的幕可指定城市（id 或 'random'） */
  const enterAct = (name, cityId, kind) => {
    const a = acts[name];
    if (!a) return Promise.resolve(false);
    let center = a.center, city = null;
    if (a.city) {
      city = cityId ? pickCity(cityId) : state.city[name];
      state.city[name] = city;
      // 生命通道的镜头先对准市中心略偏南，救护车路线由 Worker 选好后再精确对准
      center = name === 'corridor' ? [city.center[0], city.center[1] - 0.01]
        : (name === 'demand' && city.id === 'beijing') ? [116.42, 39.95] : city.center;
    }
    document.querySelectorAll('#acts button').forEach((x) => x.classList.toggle('active', x.dataset.act === name));
    if (name === 'corridor' && EVENTS[kind]) state.event = kind;
    for (const k of ['tide', 'demand', 'corridor']) {
      const lab = document.querySelector(`#acts button[data-act="${k}"] .act-city`);
      if (lab) lab.textContent = state.city[k] ? cityName(state.city[k]) + (k === 'corridor' ? ` · ${EVENTS[state.event].code}` : '') : '';
    }
    closeCityMenu();
    // 平滑运镜（百度原生关键帧动画）：拉近时先在高空平移到目标上方再降落，拉远时先升空再平移
    state.follow = null;
    state.actFly = flyCamera(map, { center, zoom: a.zoom, tilt: a.tilt, heading: a.heading || 0 });
    fleet?.setSim({ timeScale: a.scale, tod: a.tod });
    state.act = name;
    hexLayer.setVisible(name === 'demand');
    if (name === 'demand') {
      // 北京沿用原来的取景点（略偏北，热点集中在北部）；其它城市对准市中心
      startDemand(city.id === 'beijing' ? { id: 'beijing', center: [116.404, 39.93] } : { id: city.id, center: city.center });
      hexLayer._rise = 0;
    }
    // 先关掉上一条生命通道（可能在别的城市），再按需开新的
    fleet?.corridor(false);
    eventLayer.clear();
    if (name === 'corridor') {
      fleet?.corridor(true, city.id, state.event);
      toast(EVENTS[state.event].toast(cityName(city)));
    } else if (name === 'demand') {
      toast(`网约车需求预测 · ${cityName(city)} · 柱子越高 = 15 分钟后叫车的人越多，空车提前调过去`, 4200);
    } else if (name === 'tide') {
      toast(`城市潮汐 · ${cityName(city)} · 1 秒 = 3 分钟`, 2600);
    }
    if (zoneLayer) zoneLayer.visible = name === 'nation';
    // 幕切换会改图层可见性，右上角开关同步，避免「图层开着、勾选框却是空的」
    const hexBox = document.getElementById('l-hex'), zoneBox = document.getElementById('l-zones');
    if (hexBox) hexBox.checked = name === 'demand';
    if (zoneBox && zoneLayer) zoneBox.checked = zoneLayer.visible;
    document.dispatchEvent(new CustomEvent('a35:act', { detail: { act: name, map } }));
    lineFeed?.prioritize(center, a.zoom);
    return state.actFly;
  };
  window.__enterAct = enterAct;

  /* 二级菜单：城市潮汐 / 生命通道 点按钮先弹城市列表，最上面是骰子随机 */
  const menu = document.createElement('div');
  menu.id = 'city-menu';
  menu.className = 'panel hide';
  document.getElementById('app').appendChild(menu);
  function closeCityMenu() { menu.classList.add('hide'); menu.dataset.act = ''; }
  const openCityMenu = (btn) => {
    const act = btn.dataset.act;
    if (menu.dataset.act === act) return closeCityMenu();
    const cur = state.city[act]?.id;
    const kinds = act === 'corridor'
      ? `<div class="cm-kinds">${Object.entries(EVENTS).map(([k, e]) => `<button data-kind="${k}" class="${k === state.event ? 'on' : ''}"><span>${e.icon}</span>${e.label}</button>`).join('')}</div>`
      : '';
    menu.innerHTML = kinds + `<button data-city="random" class="cm-dice"><span>🎲</span>随机城市</button>`
      + realCities.map((c) => `<button data-city="${c.id}" class="${c.id === cur ? 'on' : ''}">${cityName(c)}</button>`).join('');
    menu.dataset.act = act;
    menu.classList.remove('hide');
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left + r.width / 2 - menu.offsetWidth / 2)}px`;
    const bar = document.getElementById('hud-scene').getBoundingClientRect();
    menu.style.bottom = `${Math.round(innerHeight - bar.top + 8)}px`;   // 贴在底栏上方，不压底栏
  };
  menu.addEventListener('click', (ev) => {
    // 事件种类：只切换选中状态，菜单不关，接着选城市（选当前城市即在原地换事件）
    const k = ev.target.closest('button[data-kind]');
    if (k) {
      state.event = k.dataset.kind;
      menu.querySelectorAll('button[data-kind]').forEach((x) => x.classList.toggle('on', x === k));
      return;
    }
    const b = ev.target.closest('button[data-city]');
    if (b) enterAct(menu.dataset.act, b.dataset.city, menu.dataset.act === 'corridor' ? state.event : undefined);
  });
  document.addEventListener('mousedown', (ev) => {
    if (!menu.classList.contains('hide') && !menu.contains(ev.target) && !ev.target.closest('#acts')) closeCityMenu();
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeCityMenu(); });

  document.querySelectorAll('#acts button').forEach((b) => {
    b.addEventListener('click', () => {
      if (acts[b.dataset.act]?.city) openCityMenu(b);
      else enterAct(b.dataset.act);
    });
  });

  // ?act=nation|tide|demand|corridor[&city=shanghai|random][&actdelay=秒]：打开页面后自动进入某一幕（演示链接 / 录屏用）
  const autoAct = Q.get('act');
  if (autoAct) {
    setTimeout(() => {
      dismissSplash();          // 直达某一幕的演示链接：不让入场层挡住转场
      enterAct(autoAct, Q.get('city') || undefined, Q.get('event') || undefined);
    }, Number(Q.get('actdelay') || 2.5) * 1000);
  }

  // 图层开关
  const bindToggle = (id, fn) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => fn(el.checked));
  };
  bindToggle('l-cars', (v) => vehicleLayer.setVisible(v));
  bindToggle('l-roads', (v) => { roadLayer && (roadLayer.visible = v); });
  bindToggle('l-zones', (v) => { zoneLayer && (zoneLayer.visible = v); });
  bindToggle('l-hex', (v) => { hexLayer.setVisible(v); if (v) startDemand(); });

  // 时间轴
  const tRange = document.getElementById('t-range');
  const tLabel = document.getElementById('t-label');
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const applyTod = () => {
    const m = Number(tRange.value);
    tLabel.textContent = fmt(m);
    fleet?.setSim({ tod: m });
  };
  let dragging = false;
  tRange.addEventListener('pointerdown', () => { dragging = true; });
  tRange.addEventListener('pointerup', () => { dragging = false; });
  tRange.addEventListener('input', applyTod);
  applyTod();
  setInterval(() => {
    if (dragging || fleet?.tod == null) return;
    const m = Math.round(fleet.tod);
    tRange.value = String(m);
    tLabel.textContent = fmt(m);
  }, 500);

  // 视野变化时重排路网加载优先级
  map.addEventListener('moveend', () => {
    const c = map.getCenter();
    lineFeed?.prioritize([c.lng, c.lat], map.getZoom());
  });

  // ?layoutdl=标签：版面自检 —— 各悬浮面板的位置与互相遮挡情况回传（不同屏幕尺寸下检查 UI）
  // ?fpsdl / ?snap：探针模式，同样跳过入场层，避免它盖住被测画面
  const layoutTag = Q.get('layoutdl');
  if (layoutTag || Q.get('fpsdl') || Q.get('snap')) dismissSplash();
  if (layoutTag) {
    setTimeout(() => {
      const ids = ['hud-head', 'hud-metrics', 'hud-perf', 'hud-layers', 'hud-scene'];
      const box = Object.fromEntries(ids.map((id) => {
        const b = document.getElementById(id).getBoundingClientRect();
        return [id, [b.left, b.top, b.right, b.bottom].map(Math.round)];
      }));
      const overlaps = [];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = box[ids[i]], b = box[ids[j]];
          if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) overlaps.push(`${ids[i]}×${ids[j]}`);
        }
      }
      saveResult(`layout-${layoutTag}.json`, JSON.stringify({ viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, overlaps, box, browser: browserTag() }));
    }, 3000);
  }

  // ?fpsdl=标签&warm=秒：预热后采样 8 秒帧间隔，自动下载结果（真实浏览器里做分层对照）
  const fpsTag = Q.get('fpsdl');
  if (fpsTag) {
    setTimeout(() => {
      const f = [];
      const VL = window.__layers.vehicleLayer;
      const up0 = VL.stats.totalUploadBytes || 0, sw0 = VL.stats.swaps || 0;
      const cpu = [];   // 本项目图层每帧在主线程上的耗时（onRender 内，含 GL 命令提交）
      const gpu = [];   // 车辆图层 GPU 耗时（EXT_disjoint_timer_query）
      let prev = performance.now();
      const t0 = prev;
      const loop = () => {
        const now = performance.now();
        f.push(now - prev);
        prev = now;
        const Ls = Object.values(window.__layers || {}).filter(Boolean);
        cpu.push(Ls.reduce((a, L) => a + (L.stats?.drawMs || 0), 0));
        const g = window.__layers?.vehicleLayer?.stats.gpuMs;
        if (g != null && g > 0) gpu.push(g);
        if (now - t0 < 8000) return requestAnimationFrame(loop);
        const s = [...f].sort((a, b) => a - b);
        const L = window.__layers;
        const r = {
          tag: fpsTag, q: location.search,
          fps: +(1000 / (f.reduce((a, b) => a + b, 0) / f.length)).toFixed(1),
          p50: +s[s.length >> 1].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s[s.length - 1].toFixed(0),
          cars: L.vehicleLayer.totalCount, lodK: L.vehicleLayer.stats.lodK,
          upMBps: +(L.vehicleLayer.stats.uploadMBps || 0).toFixed(1), upMsPerSec: +(L.vehicleLayer.stats.uploadMsPerSec || 0).toFixed(1), roadPrims: L.roadLayer?.stats.prims, zoneVerts: L.zoneLayer?.fillCount,
          dpr: devicePixelRatio, zoom: map.getZoom(),
          ourCpuMs: +(cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length)).toFixed(2),
          ourCpuP95: +([...cpu].sort((a, b) => a - b)[Math.floor(cpu.length * 0.95)] || 0).toFixed(2),
          gpuMs: gpu.length ? +(gpu.reduce((a, b) => a + b, 0) / gpu.length).toFixed(2) : null,
          browser: browserTag(), ua: navigator.userAgent, frames: f.length,
          // 数据新鲜度（整个采样窗口的平均）：每个分片每秒换页几次（理想为 1 Hz）、实际上传 MB/s
          snapHz: +(((VL.stats.swaps || 0) - sw0) / (8 * Math.max(1, VL.parts.filter((p) => p.filled).length))).toFixed(2),
          upMBpsAvg: +((((VL.stats.totalUploadBytes || 0) - up0) / 1048576) / 8).toFixed(1),
          needMBps: +((VL.totalCount * 16) / 1048576).toFixed(1),
          workerStepMs: window.__fleet ? +window.__fleet.avgStepMs().toFixed(1) : null,
          workers: window.__fleet?.workers?.length,
          // HUD 上显示的数字（核对口径用）
          hudLoadMB: +(state.bytes / 1048576).toFixed(1), hudLoadMBps: +state.rate.toFixed(1),
        };
        saveResult(`fps-${fpsTag}.json`, JSON.stringify(r));
      };
      requestAnimationFrame(loop);
    }, Number(Q.get('warm') || 15) * 1000);
  }

  // 内置性能测试（?bench=1）：严格测量模式，不加入演示层，保证测量条件稳定
  if (params.bench) {
    dismissSplash();          // 测试模式直接进入中枢，入场层不遮挡画面
    bench = new Bench({ map, layers: window.__layers, state, fleet: window.__fleet, params });
    window.__benchObj = bench;
    const PH = { loading: '加载', steady: '稳态', interact_pan: '平移', interact_zoom: '缩放', interact_rotate: '旋转', interact_tilt: '倾斜', city_zoom13: '近景' };
    const phases = Object.keys(PH);
    const head = `性能测试模式 · 车辆 <b>${params.fleet.toLocaleString()}</b>`;
    const sub = '请不要移动鼠标，测试约 1 分钟，完成后显示结果';
    modeBanner(head, sub);
    bench.onPhase = (name) => {
      const i = phases.indexOf(name);
      if (i >= 0) modeBanner(head, sub, `${i + 1} / ${phases.length} · ${PH[name]}`);
    };
    bench.run().then((r) => {
      modeBanner(null);
      window.__benchResult = r;
      const md = toMarkdown(r);
      window.__benchMd = md;
      console.log('[bench] 完成\n' + md);
      showBenchPanel(r, md);
      // ?autodl=标签：结束后自动下载结果（用于无自动化工具的真实浏览器批量测试）
      const tag = Q.get('autodl');
      if (tag) {
        saveResult(`bench-${tag}.md`, md, 'text/markdown')
          .then(() => saveResult(`bench-${tag}.json`, JSON.stringify(r, null, 2)));
      }
    });
  }

  // ?debug=1：演示模式（显示帧率面板 + 自动播放四幕，但一动鼠标就让位）
  if (params.demo) {
    // 切幕：与手动点选同一条路径（enterAct），返回该幕的运镜 Promise；城市级的幕传 'random' 掷骰子
    const goAct = (name, city) => enterAct(name, city, name === 'corridor' ? (Math.random() < 0.5 ? 'fire' : 'ambulance') : undefined);
    const cityOf = (name) => (name === 'event' ? state.event : state.city[name]?.name.replace(/市$/, '') || '');
    const go = () => setTimeout(() => startDemo(map, goAct, cityOf), 1500);
    // 入场层收起后开始；若此时已经收起（如 ?act= 链接）则直接开始
    if (document.getElementById('splash')?.classList.contains('hide')) go();
    else document.addEventListener('a35:splashDone', go, { once: true });
  }

  document.title = `Apollo 2035 · ${cities.length} 城市 · ${params.fleet.toLocaleString()} 辆`;
}

let splashTimer = 0;

/**
 * 入场覆盖层：把「接入进度」做成一个可见的数字。
 *
 * 目标值恒为真实的车辆总数（params.fleet，默认 100 万），显示值只跟随
 * 图层里真实上屏的车辆数（state.cars）—— 覆盖层上写多少车，中枢里就有多少车，
 * 数字永远由数据驱动，不会出现「写着 300 万、实际 100 万」这种对不上的情况。
 * 显示值做了缓动，让数字是滚动上去而不是跳变；真实值涨得更快时立即跟上。
 */
function runSplash(target) {
  const el = (id) => document.getElementById(id);
  const cars = el('s-cars'), bar = el('s-bar'), st = el('s-state');
  let shown = 0;
  const stop = () => { clearInterval(splashTimer); splashTimer = 0; };
  const done = () => {
    stop();
    st.textContent = '接入完成 · 实时运营中';
    // 完成后停一下再进入中枢，给「全国点亮」留出观看时间
    setTimeout(dismissSplash, 1800);
  };
  splashTimer = setInterval(() => {
    // 缓动跟随真实进度（数据没到位时数字也保持滚动，否则像卡死）
    const real = Math.min(state.cars, target);
    shown += (real - shown) * 0.42;
    if (real >= target) shown = target;
    const v = Math.min(Math.floor(Math.max(shown, 0)), target);
    cars.textContent = v.toLocaleString();
    bar.style.width = `${((v / target) * 100).toFixed(1)}%`;
    el('s-mb').textContent = `${(state.bytes / 1048576).toFixed(1)} MB`;
    el('s-rate').textContent = `${state.rate.toFixed(1)} MB/s`;
    el('s-feat').textContent = state.visible.toLocaleString();
    // 城市按「唯一编号」计数：大城市的数据被拆成多帧，同一座城会到达多次
    el('s-city').textContent = `${state.citiesOn?.size || 0} / ${state.citiesTotal || 0}`;
    if (v >= target) done();
  }, 100);
  // ?splashms=毫秒：限制入场层最长停留（测试 / 录屏用；不传或传 0 时最长 15 秒）
  const maxMs = Q.get('splashms') != null ? Number(Q.get('splashms')) : 0;
  setTimeout(() => { stop(); dismissSplash(); }, maxMs > 0 ? maxMs : 15000);
}

function dismissSplash() {
  const sp = document.getElementById('splash');
  if (!sp || sp.classList.contains('hide')) return;
  sp.classList.add('hide');
  clearInterval(splashTimer);
  state.tSplashDismiss = performance.now();
  document.dispatchEvent(new CustomEvent('a35:splashDone'));
}

/** 一天中的载客率（与仿真 Worker 的 stateMix 同一口径），用于城市光晕配色 */
function tripShareAt(tod) {
  const h = tod / 60;
  const peak = Math.max(0, 1 - Math.abs(h - 8) / 2.0) + Math.max(0, 1 - Math.abs(h - 18) / 2.4);
  const night = Math.max(0, 1 - Math.abs(((h + 21) % 24) - 6) / 4);
  const trip = 0.12 + 0.33 * (1 - night) + 0.17 * Math.min(1, peak);
  return Math.min(1, Math.max(0, (trip - 0.12) / 0.5));
}

/** 屏幕中央提示 */
function toast(text, ms = 3200) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.innerHTML = text;
  t.classList.remove('hide');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hide'), ms);
}

/** 顶部模式提示条（演示 / 性能测试）；title 为 null 时收起 */
function modeBanner(title, sub = '', phase = '') {
  const el = document.getElementById('mode-banner');
  if (!el) return;
  if (!title) { el.classList.add('hide'); return; }
  el.innerHTML = `<div class="mb-title">${title}</div><div class="mb-sub">${sub}</div>${phase ? `<div class="mb-phase">${phase}</div>` : ''}`;
  el.classList.remove('hide');
}

boot().catch((e) => {
  console.error(e);
  const t = document.getElementById('toast');
  if (t) { t.textContent = '启动失败：' + e.message; t.classList.remove('hide'); }
  const s = document.getElementById('s-state');
  if (s) s.textContent = '启动失败：' + e.message;
});

/** 测试结果面板：可下载 JSON / Markdown */
function showBenchPanel(r, md) {
  const el = document.createElement('section');
  el.className = 'panel bench-panel';
  const P = r.phases;
  const line = (k, p) => p ? `<tr><td>${k}</td><td>${p.avgFps}</td><td>${p.low1Fps}</td><td>${p.p95Ms}</td><td>${p.jank}</td></tr>` : '';
  // 按钮放在标题行：省出一行高度，笔记本屏幕上不压住下方的帧率面板
  el.innerHTML = `<div class="bench-head"><h3>性能测试完成</h3>
      <div class="bench-actions"><button id="bench-json" title="下载 JSON">⤓ JSON</button><button id="bench-md" title="下载 Markdown">⤓ MD</button><button id="bench-close" title="关闭">×</button></div></div>
    <p class="bench-meta">车辆 ${r.meta.fleet.toLocaleString()} · 仿真 Worker ${r.workers?.count ?? '—'} · 内核 ${(r.meta.kernel || '').toUpperCase()}</p>
    <p>首辆车 ${P.loading.firstCarMs} ms · 首条路网 ${P.loading.firstLineMs} ms · 全量 ${P.loading.allLoadedMs} ms</p>
    <table><tr><th>阶段</th><th>FPS</th><th>1%Low</th><th>P95ms</th><th>卡顿</th></tr>
    ${line('加载中', P.loading)}${line('稳态', P.steady)}${line('平移', P.interact_pan)}${line('缩放', P.interact_zoom)}${line('旋转', P.interact_rotate)}${line('倾斜', P.interact_tilt)}${line('近景', P.city_zoom13)}
    </table>`;
  document.getElementById('app').appendChild(el);
  el.querySelector('#bench-close').onclick = () => el.remove();
  const dl = (name, text, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
  };
  const tag = `${r.meta.fleet}-${Date.now()}`;
  el.querySelector('#bench-json').onclick = () => dl(`bench-${tag}.json`, JSON.stringify(r, null, 2), 'application/json');
  el.querySelector('#bench-md').onclick = () => dl(`bench-${tag}.md`, md, 'text/markdown');
}

/**
 * 平滑运镜：百度 GL 原生关键帧动画（ViewAnimation），由地图引擎逐帧插值、自己调度瓦片。
 * （曾用 JS 定时器逐步 setCenter / setZoom 实现：每个中间缩放级别都触发瓦片请求，
 *   主线程被堵死约 15 秒，实测。所以运镜一律交给引擎。）
 *
 * 远距离拉近：先在高空横移到目标上方，再降落 —— 「从一个地方慢慢放大」；
 * 远距离拉远：先原地升空，再横移回去。
 * 返回 Promise<boolean>：飞完为 true；被新的运镜打断为 false。
 */
function flyCamera(map, target, ms) {
  if (flyCamera.anim) {
    try { map.cancelViewAnimation(flyCamera.anim); } catch { /* 已结束 */ }
    flyCamera.resolve?.(false);
  }
  const c0 = map.getCenter();
  const z0 = map.getZoom();
  const h0 = map.getHeading() || 0, t0 = map.getTilt() || 0;
  const [lng, lat] = target.center;
  const dz = target.zoom - z0;
  const dist = Math.hypot(lng - c0.lng, lat - c0.lat);            // 经纬度距离（度）
  const dur = ms ?? Math.round(Math.min(7000, 1600 + Math.abs(dz) * 420 + Math.min(dist, 30) * 50));
  let h1 = target.heading || 0;                                    // 转向走最短的方向
  while (h1 - h0 > 180) h1 -= 360;
  while (h1 - h0 < -180) h1 += 360;
  const P = (x, y) => new BMap.Point(x, y);
  const frames = [{ center: P(c0.lng, c0.lat), zoom: z0, tilt: t0, heading: h0, percentage: 0 }];
  if (dz > 2 && dist > 0.3) {
    // 拉近：缩放只走 25%，先在高空横移到目标正上方
    frames.push({ center: P(lng, lat), zoom: z0 + dz * 0.25, tilt: t0 * 0.5, heading: h0 + (h1 - h0) * 0.3, percentage: 0.45 });
  } else if (dz < -2 && dist > 0.3) {
    // 拉远：先在原地升空（缩放走 75%），再横移
    frames.push({ center: P(c0.lng + (lng - c0.lng) * 0.15, c0.lat + (lat - c0.lat) * 0.15), zoom: z0 + dz * 0.75, tilt: t0 * 0.3, heading: h0 + (h1 - h0) * 0.6, percentage: 0.5 });
  }
  frames.push({ center: P(lng, lat), zoom: target.zoom, tilt: target.tilt || 0, heading: h1, percentage: 1 });

  const anim = new BMap.ViewAnimation(frames, { duration: dur, delay: 0, interation: 1 });
  flyCamera.anim = anim;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (flyCamera.anim === anim) { flyCamera.anim = null; flyCamera.resolve = null; }
      resolve(ok);
    };
    flyCamera.resolve = finish;
    anim.addEventListener('animationend', () => finish(true));
    anim.addEventListener('animationcancel', () => finish(false));
    // 兜底：个别情况下引擎不发结束事件
    setTimeout(() => finish(true), dur + 1500);
    map.startViewAnimation(anim);
  });
}

/**
 * 演示模式（?debug=1）：入场后自动播放四幕，平滑运镜，每幕配一句说明。
 * 用户一按鼠标 / 滚轮 / 按键 / 触摸，演示立刻停止、镜头动画取消，让位给手动操作。
 */
function startDemo(map, goAct, cityOf) {
  let stopped = false;
  const evs = ['mousedown', 'wheel', 'keydown', 'touchstart'];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    evs.forEach((ev) => window.removeEventListener(ev, stop, true));
    if (flyCamera.anim) { try { map.cancelViewAnimation(flyCamera.anim); } catch { /* 已结束 */ } }
    modeBanner(null);
    toast('自动演示已停止 · 可自由操作', 2000);
  };
  evs.forEach((ev) => window.addEventListener(ev, stop, { capture: true, passive: true }));
  modeBanner('演示模式 · <b>自动播放中</b>', '请不要移动鼠标，点击、滚轮或按键会中断演示');

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const wan = Math.round(params.fleet / 10000);
  // [幕, 城市（random = 掷骰子）, 说明, 落定后停留毫秒]
  const script = [
    ['nation', null, () => `全国脉搏 · ${wan} 万辆无人车实时在线，城市逐座点亮`, 5000],
    ['tide', 'random', () => `城市潮汐 · ${cityOf('tide')}早高峰，1 秒 = 3 分钟，载客车流涌向市中心`, 9000],
    ['demand', 'random', () => `网约车需求预测 · ${cityOf('demand')} · 预测 15 分钟后哪里有人叫车，提前把空车调过去`, 9000],
    ['corridor', 'random', () => (cityOf('event') === 'fire'
      ? `119 火警 · ${cityOf('corridor')} · 警车开道，消防车队穿城，沿途车辆靠边让行`
      : `120 生命通道 · ${cityOf('corridor')} · 救护车穿城，前方车辆自动靠边让行`), 18000],
    ['nation', null, () => '回到全国 · 演示结束，可自由操作', 0],
  ];
  (async () => {
    for (const [act, city, caption, hold] of script) {
      if (stopped) return;
      const fly = goAct(act, city || undefined);
      toast(caption(), 4500);
      await fly;
      if (stopped) return;
      await wait(hold);
    }
    evs.forEach((ev) => window.removeEventListener(ev, stop, true));
    modeBanner(null);
  })();
}
