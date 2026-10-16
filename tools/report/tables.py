"""
从 docs/bench/real-browser/raw 下的原始结果生成性能报告用的 Markdown 表格。
用法：python3 tools/report/tables.py > /tmp/tables.md
数字全部来自原始 JSON / TSV，避免手抄出错。
"""
import json, os, csv, sys

R = os.path.join(os.path.dirname(__file__), '..', '..', 'docs', 'bench', 'real-browser', 'raw')
J = lambda n: json.load(open(os.path.join(R, n)))
def fps(tag):
    try: return J(f'fps-{tag}.json')
    except FileNotFoundError: return None

out = []
P = out.append

# —— 加载阶段 ——
benches = [('Safari · 100 万辆', 'bench-FINAL-SF-1m.json'), ('Chrome · 100 万辆', 'bench-FINAL-CR-1m.json'), ('Chrome · 400 万辆', 'bench-FINAL-CR-4m.json')]
B = [(n, J(f)) for n, f in benches]
P('### T-LOAD')
P('| 指标 | ' + ' | '.join(n for n, _ in B) + ' |')
P('|---|' + '---|' * len(B))
rows = [
  ('地图引擎就绪', lambda b: f"{b['phases']['loading']['mapReadyMs']} ms"),
  ('**首条路网上屏**', lambda b: f"**{b['phases']['loading']['firstLineMs']} ms**"),
  ('**首辆车上屏**', lambda b: f"**{b['phases']['loading']['firstCarMs']} ms**"),
  ('首个区域面上屏', lambda b: f"{b['phases']['loading']['firstZoneMs']} ms"),
  ('**全部数据上屏**', lambda b: f"**{b['phases']['loading']['allLoadedMs']} ms**"),
  ('接入数据量', lambda b: f"{b['phases']['loading']['bytesMB']} MB"),
  ('持续加载速度', lambda b: f"{b['phases']['loading']['throughputMBs']} MB/s"),
  ('车辆上屏速度', lambda b: f"{b['phases']['loading']['carsPerSec']:,} 辆/s"),
  ('车辆 / 路网线段 / 面顶点', lambda b: f"{b['phases']['loading']['carsLoaded']:,} / {b['phases']['loading']['roadSegments']:,} / {b['phases']['loading']['zoneVertices']:,}"),
]
for name, f in rows: P(f'| {name} | ' + ' | '.join(f(b) for _, b in B) + ' |')

# —— 各阶段帧率 ——
names = {'loading': '数据加载中', 'steady': '稳态（静止）', 'interact_pan': '交互：平移', 'interact_zoom': '交互：缩放', 'interact_rotate': '交互：旋转', 'interact_tilt': '交互：倾斜', 'city_zoom13': '城市近景 z13'}
for title, b in B:
    P(f'\n### T-FPS {title}')
    P('| 阶段 | 平均 FPS | 1% Low | P95 帧时 | 最长帧 | 卡顿帧(>50ms) | 长任务 | 主线程忙碌 | GPU ms/帧 |')
    P('|---|---|---|---|---|---|---|---|---|')
    for k, n in names.items():
        p = b['phases'][k]
        g = '-' if p.get('gpuMsAvg') is None else p['gpuMsAvg']
        P(f"| {n} | **{p['avgFps']}** | {p['low1Fps']} | {p['p95Ms']} ms | {p['maxMs']} ms | {p['jank']} | {p['longTasks']} | {p['mainThreadBusyPct']}% | {g} |")
    w = b['workers']; m = b['memEnd']
    P(f"\n仿真 Worker {w['count']} 个，每个每秒仿真耗时 {w['stepMsPerSec']} ms（≈ {w['cpuPctPerWorker']}% 单核）；"
      f"显存（本项目缓冲区）{m['gpuBuffersMB']} MB；JS 堆 {m['jsHeapMB'] if m.get('jsHeapMB') is not None else '浏览器不提供'}{' MB' if m.get('jsHeapMB') is not None else ''}。")

# —— 浏览器 × 规模 ——
P('\n### T-SCALE')
P('| 实时仿真 + 全部图层 | Safari FPS（P95 / 最长帧） | Chrome FPS（P95 / 最长帧） | Chrome 不限帧率 FPS（单帧中位数） |')
P('|---|---|---|---|')
for k, label in [('30w', '30 万辆'), ('100w', '100 万辆'), ('200w', '200 万辆')]:
    s, c, u = fps(f'Q-SF-{k}'), fps(f'Q-CR-{k}'), fps(f'Q-CU-{k}')
    P(f"| {label} | **{s['fps']}**（{s['p95']} / {s['max']} ms） | **{c['fps']}**（{c['p95']} / {c['max']} ms） | {u['fps']}（{u['p50']} ms） |")
s, c = fps('Q-SF-bare'), fps('Q-CR-bare')
P(f"| 百度空地图（基线） | {s['fps']}（{s['p95']} / {s['max']} ms） | {c['fps']}（{c['p95']} / {c['max']} ms） | — |")

# —— 实时仿真最大规模 + 新鲜度 ——
P('\n### T-LIVE')
P('| 实时仿真车辆 | 浏览器 | 平均 FPS | P95 帧时 | 最长帧 | 快照更新频率 | 实际上传 / 理论需要 | 每 Worker 仿真耗时 |')
P('|---|---|---|---|---|---|---|---|')
for tag, n in [('G-CR-100w', '100 万'), ('G-CR-200w', '200 万'), ('G-CR-400w', '400 万'), ('G-CR-600w', '600 万'), ('G-SF-600w', '600 万'), ('G-CR-800w', '800 万')]:
    r = fps(tag)
    if not r: continue
    P(f"| {n} | {r['browser'].capitalize()} | **{r['fps']}** | {r['p95']} ms | {r['max']} ms | {r['snapHz']} Hz | {r['upMBpsAvg']} / {r['needMBps']} MB/s | {r['workerStepMs']} ms/s |")
for tag, n in [('M-SF-300w', '300 万'), ('M-SF-400w', '400 万'), ('M-SF-800w', '800 万')]:
    r = fps(tag)
    if r: P(f"| {n} | Safari | **{r['fps']}** | {r['p95']} ms | {r['max']} ms | — | — | — |")

# —— 纯渲染 ——
P('\n### T-STRESS')
P('| 静态车辆（只开车辆图层） | Safari FPS（P95） | Chrome FPS（P95） | Chrome 车辆图层 GPU 耗时 |')
P('|---|---|---|---|')
for k, n in [('200w', '200 万'), ('400w', '400 万'), ('800w', '800 万')]:
    s, c = fps(f'Z-SF-{k}'), fps(f'Z-CR-{k}')
    P(f"| {n} | **{s['fps']}**（{s['p95']} ms） | **{c['fps']}**（{c['p95']} ms） | {c['gpuMs']} ms |")

# —— LOD 对照 ——
P('\n### T-LOD')
P('| 200 万静态车，全国视角 | LOD 开 | LOD 关 | 提升 |')
P('|---|---|---|---|')
for b, n in [('ch', 'Chrome'), ('sa', 'Safari')]:
    on, off = fps(f'LOD1-{b}-2m'), fps(f'LOD0-{b}-2m')
    extra = f"，GPU {on['gpuMs']} ms vs {off['gpuMs']} ms（{off['gpuMs']/on['gpuMs']:.1f}×）" if on.get('gpuMs') else ''
    P(f"| {n} | **{on['fps']} FPS**（P95 {on['p95']} ms） | {off['fps']} FPS（P95 {off['p95']} ms） | 帧率 {on['fps']/off['fps']:.1f}×{extra} |")

# —— WASM 浏览器内（同条件背靠背三轮，200 万辆）——
P('\n### T-WASM')
P('| 轮次 | WASM 内核（每 Worker ms/s） | JS 内核（每 Worker ms/s） | 帧率（WASM / JS） | 快照频率（WASM / JS） |')
P('|---|---|---|---|---|')
ws, js_ = [], []
for i in (1, 2, 3):
    a, b = fps(f'K{i}-wasm1'), fps(f'K{i}-wasm0')
    if not a or not b: continue
    ws.append(a['workerStepMs']); js_.append(b['workerStepMs'])
    P(f"| {i} | {a['workerStepMs']} | {b['workerStepMs']} | {a['fps']} / {b['fps']} | {a['snapHz']} / {b['snapHz']} Hz |")
if ws:
    mw, mj = sum(ws) / len(ws), sum(js_) / len(js_)
    P(f"| **平均** | **{mw:.1f}** | **{mj:.1f}** | — | — |")
    P(f"\n浏览器内加速比 **{mj / mw:.2f}×**（Chrome，200 万辆，6 个 Worker）。")

print('\n'.join(out))
