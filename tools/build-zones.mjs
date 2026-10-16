/**
 * 行政区划面数据：把 DataV 的 GeoJSON 合并成 NDJSON（每行一个 Feature），
 * 这样前端用流式解析就能「下载到哪、画到哪」。
 * 省级面先写（大范围底图），再写地级市面（更细）。
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('data-src.noindex/datav');
const OUT = path.resolve('public/data/zones.ndjson');
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('_full.json'));

// 国家级优先，其次省级，最后市级
const order = (f) => (f.startsWith('100000') ? 0 : f.length === 11 ? 1 : 2);
files.sort((a, b) => order(a) - order(b));

const w = fs.createWriteStream(OUT);
let n = 0;
for (const f of files) {
  let fc;
  try { fc = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8')); } catch { continue; }
  for (const feat of fc.features) {
    const p = feat.properties || {};
    // 只要面要素，并精简属性
    if (!feat.geometry || (feat.geometry.type !== 'Polygon' && feat.geometry.type !== 'MultiPolygon')) continue;
    // 台湾省只保留轮廓（无下级数据），不影响演示
    const slim = {
      type: 'Feature',
      properties: { adcode: p.adcode, name: p.name, level: p.level || (f.startsWith('100000') ? 'province' : 'city') },
      geometry: feat.geometry,
    };
    w.write(JSON.stringify(slim) + '\n');
    n++;
  }
}
w.end();
w.on('finish', () => {
  const { size } = fs.statSync(OUT);
  console.log(`zones.ndjson: ${n} 个面要素, ${(size / 1e6).toFixed(1)} MB`);
});
