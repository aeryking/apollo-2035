/**
 * 从 OpenStreetMap（Overpass API）拉取真实路网，保存原始 JSON 到 data-src.noindex/。
 * 数据许可：ODbL，© OpenStreetMap contributors。
 *
 * 用法：node tools/fetch-osm.mjs [task...]
 *   task 取值见 TASKS；不传则全部拉取。已存在的文件跳过。
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('data-src.noindex');
// 主站对北京这种大范围查询频繁 504，用法国镜像做主力，主站兜底
const APIS = (process.env.OVERPASS || 'https://overpass.openstreetmap.fr/api/interpreter,https://overpass-api.de/api/interpreter').split(',');

// 城市级：主干道及以上；全国级：高速 + 国道主干
const CITY_LEVELS = 'motorway|motorway_link|trunk|trunk_link|primary|secondary|tertiary';
const TASKS = {
  // 北京：拆成 4 块拉取，避免单次查询 504
  // 北京核心区（五环内，演示主战场）：主干道全要
  'beijing-core': { bbox: [39.78, 116.22, 40.05, 116.60], levels: 'motorway|motorway_link|trunk|trunk_link|primary|secondary|tertiary' },
  // 北京外围：只要快速路，保证全国视角连得起来
  'beijing-ring': { bbox: [39.60, 116.00, 40.25, 116.90], levels: 'motorway|motorway_link|trunk' },
  // 武汉：萝卜快跑运营大本营
  wuhan: { bbox: [30.40, 114.10, 30.75, 114.55], levels: CITY_LEVELS },
  // 上海 / 深圳 / 广州 / 成都 / 重庆 / 杭州：2026-10-15 起补支路（tertiary），城区路网与北京、武汉同一密度
  shanghai: { bbox: [31.05, 121.25, 31.42, 121.70], levels: 'motorway|trunk|primary|secondary|tertiary' },
  shenzhen: { bbox: [22.48, 113.85, 22.75, 114.25], levels: 'motorway|trunk|primary|secondary|tertiary' },
  guangzhou: { bbox: [22.95, 113.15, 23.25, 113.50], levels: 'motorway|trunk|primary|secondary|tertiary' },
  chengdu: { bbox: [30.50, 103.90, 30.80, 104.25], levels: 'motorway|trunk|primary|secondary|tertiary' },
  // 重庆主城（渝中 / 江北 / 南岸 / 沙坪坝 / 九龙坡 / 渝北）：立交多，匝道（*_link）一起要
  chongqing: { bbox: [29.40, 106.33, 29.76, 106.75], levels: 'motorway|motorway_link|trunk|trunk_link|primary|secondary|tertiary' },
  // 杭州主城（西湖 / 上城 / 拱墅 / 滨江 / 萧山北）
  hangzhou: { bbox: [30.13, 119.98, 30.40, 120.35], levels: 'motorway|motorway_link|trunk|trunk_link|primary|secondary|tertiary' },
  // 全国高速：按 4 个经度带分片拉，避免单次超时
  'nation-w': { bbox: [18, 73, 54, 100], levels: 'motorway', nation: true },
  'nation-c1': { bbox: [18, 100, 54, 110], levels: 'motorway', nation: true },
  'nation-c2': { bbox: [18, 110, 54, 117], levels: 'motorway', nation: true },
  'nation-e': { bbox: [18, 117, 54, 135], levels: 'motorway', nation: true },
};

function query({ bbox, levels }) {
  const [s, w, n, e] = bbox;
  // out geom：直接带坐标，省去 node 关联；skel 精简标签
  return `[out:json][timeout:600][maxsize:1073741824];
way["highway"~"^(${levels})$"](${s},${w},${n},${e});
out tags geom qt;`;
}

async function fetchTask(name, task) {
  const file = path.join(OUT, `osm-${name}.json`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) {
    console.log(`[skip] ${name} 已存在 (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
    return;
  }
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const API = APIS[(attempt - 1) % APIS.length];
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'apollo2035-demo/0.1 (competition demo)' },
        body: 'data=' + encodeURIComponent(query(task)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf[0] !== 0x7b) throw new Error('非 JSON 响应：' + buf.subarray(0, 120).toString());
      fs.writeFileSync(file, buf);
      const n = (buf.toString('utf8').match(/"type": "way"/g) || []).length;
      console.log(`[ok] ${name}: ${(buf.length / 1e6).toFixed(1)} MB, ~${n} ways, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      return;
    } catch (e) {
      console.log(`[retry ${attempt}] ${name}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 15000 * attempt));
    }
  }
  console.log(`[fail] ${name}`);
}

fs.mkdirSync(OUT, { recursive: true });
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TASKS);
for (const n of names) {
  if (!TASKS[n]) { console.log('未知任务', n); continue; }
  await fetchTask(n, TASKS[n]);
}
