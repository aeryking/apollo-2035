/**
 * 拉取 DataV.GeoAtlas 行政区划（GCJ02），保存到 data-src.noindex/。
 *  - 100000_full.json：全国省级面
 *  - 各省 *_full.json：地级市面（含 center / centroid）
 *  - 重点城市区县：北京 110000_full、武汉 420100_full
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('data-src.noindex/datav');
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound/';
fs.mkdirSync(OUT, { recursive: true });

async function get(code) {
  const file = path.join(OUT, `${code}_full.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(`${BASE}${code}_full.json`, { headers: { referer: 'https://datav.aliyun.com/' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      fs.writeFileSync(file, txt);
      return JSON.parse(txt);
    } catch (e) {
      if (i === 3) { console.log('fail', code, e.message); return null; }
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

const nation = await get(100000);
console.log('provinces', nation.features.length);
let cities = 0;
for (const f of nation.features) {
  const { adcode, name, childrenNum } = f.properties;
  if (!adcode || adcode === '100000_JD') continue;
  // 直辖市 / 港澳台：子级即区县
  const fc = await get(adcode);
  if (fc) cities += fc.features.length;
  process.stdout.write(`${name}:${fc ? fc.features.length : 0} `);
}
console.log('\ncities/districts total', cities);
await get(420100); // 武汉市区县
console.log('done');
