/**
 * 坐标投影：BD09 经纬度 → 百度墨卡托（BD09MC）→ 图层相对坐标
 *
 * WebGLLayer 的 render(gl, mvp) 给出的 MVP 作用在「相对墨卡托」上：
 *   rel = BD09MC(lnglat) - BASE_MC
 * BASE_MC 为 JSAPI 内置常量（全国中心附近），不随平移漂移，实测见 docs/技术方案.md。
 *
 * BD09MC 不是标准 Web Mercator，而是百度的分纬度带多项式拟合。
 * 系数表与算法与 JSAPI 运行时 convertLL2MC 完全一致（从官方运行时移植），
 * 这样 Worker 里不依赖 BMap 也能算出与底图逐像素对齐的坐标。
 */

export const BASE_MC = [12069475.280738307, 3929271.1724863998];

const LLBAND = [86, 60, 45, 30, 15, 0];
const LL2MC = [
  [-0.0015702102444, 111320.7020616939, 1704480524535203, -10338987376042340, 26112667856603880, -35149669176653700, 26595700718403920, -10725012454188240, 1800819912950474, 82.5],
  [0.0008277824516172526, 111320.7020463578, 647795574.6671607, -4082003173.641316, 10774905663.51142, -15171875531.51559, 12053065338.62167, -5124939663.577472, 913311935.9512032, 67.5],
  [0.00337398766765, 111320.7020202162, 4481351.045890365, -23393751.19931662, 79682215.47186455, -115964993.2797253, 97236711.15602145, -43661946.33752821, 8477230.501135234, 52.5],
  [0.00220636496208, 111320.7020209128, 51751.86112841131, 3796837.749470245, 992013.7397791013, -1221952.21711287, 1340652.697009075, -620943.6990984312, 144416.9293806241, 37.5],
  [-0.0003441963504368392, 111320.7020576856, 278.2353980772752, 2485758.690035394, 6070.750963243378, 54821.18345352118, 9540.606633304236, -2710.55326746645, 1405.483844121726, 22.5],
  [-0.0003218135878613132, 111320.7020701615, 0.00369383431289, 823725.6402795718, 0.46104986909093, 2351.343141331292, 1.58060784298199, 8.77738589078284, 0.37238884252424, 7.45],
];

function bandOf(lat) {
  for (let i = 0; i < LLBAND.length; i++) if (lat >= LLBAND[i]) return LL2MC[i];
  for (let i = 0; i < LLBAND.length; i++) if (lat <= -LLBAND[i]) return LL2MC[i];
  return LL2MC[LL2MC.length - 1];
}

/** BD09 经纬度 → BD09MC，写入 out[o], out[o+1]（避免分配） */
export function ll2mc(lng, lat, out, o = 0) {
  while (lng > 180) lng -= 360;
  while (lng < -180) lng += 360;
  lat = lat < -85 ? -85 : lat > 85 ? 85 : lat;
  const t = bandOf(lat);
  const x = t[0] + t[1] * Math.abs(lng);
  const i = Math.abs(lat) / t[9];
  const y = t[2] + i * (t[3] + i * (t[4] + i * (t[5] + i * (t[6] + i * (t[7] + i * t[8])))));
  out[o] = lng < 0 ? -x : x;
  out[o + 1] = lat < 0 ? -y : y;
  return out;
}

/* 反投影：BD09MC → BD09 经纬度（同样移植自 JSAPI 运行时 convertMC2LL） */
const MCBAND = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0];
const MC2LL = [
  [1.410526172116255e-8, 0.00000898305509648872, -1.9939833816331, 200.9824383106796, -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653, 17337981.2],
  [-7.435856389565537e-9, 0.000008983055097726239, -0.78625201886289, 96.32687599759846, -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375, 10260144.86],
  [-3.030883460898826e-8, 0.00000898305509983578, 0.30071316287616, 59.74293618442277, 7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475, 6856817.37],
  [-1.981981304930552e-8, 0.000008983055099779535, 0.03278182852591, 40.31678527705744, 0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561, 4482777.06],
  [3.09191371068437e-9, 0.000008983055096812155, 0.00006995724062, 23.10934304144901, -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332, 2555164.4],
  [2.890871144776878e-9, 0.000008983055095805407, -3.068298e-8, 7.47137025468032, -0.00000353937994, -0.02145144861037, -0.00001234426596, 0.00010322952773, -0.00000323890364, 826088.5],
];

/** BD09MC → BD09 经纬度，写入 out[o], out[o+1] */
export function mc2ll(x, y, out, o = 0) {
  const ay = Math.abs(y);
  let t = MC2LL[MC2LL.length - 1];
  for (let i = 0; i < MCBAND.length; i++) if (ay >= MCBAND[i]) { t = MC2LL[i]; break; }
  const lng = t[0] + t[1] * Math.abs(x);
  const k = ay / t[9];
  const lat = t[2] + k * (t[3] + k * (t[4] + k * (t[5] + k * (t[6] + k * (t[7] + k * t[8])))));
  out[o] = x < 0 ? -lng : lng;
  out[o + 1] = y < 0 ? -lat : lat;
  return out;
}

/** 图层相对坐标 → BD09 经纬度 */
export function rel2ll(x, y, out, o = 0) {
  return mc2ll(x + BASE_MC[0], y + BASE_MC[1], out, o);
}

/** BD09 经纬度 → 图层相对坐标（米级，float32 安全） */
export function ll2rel(lng, lat, out, o = 0) {
  ll2mc(lng, lat, out, o);
  out[o] -= BASE_MC[0];
  out[o + 1] -= BASE_MC[1];
  return out;
}

/* ---------- WGS84 / GCJ02 → BD09（OSM 等开源数据需要） ---------- */
const PI = Math.PI;
const XPI = (PI * 3000) / 180;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return r;
}
function tLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return r;
}
export function wgs2gcj(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = tLat(lng - 105, lat - 35);
  let dLng = tLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sq = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sq)) * PI);
  dLng = (dLng * 180) / ((A / sq) * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}
export function gcj2bd(lng, lat) {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * XPI);
  const th = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * XPI);
  return [z * Math.cos(th) + 0.0065, z * Math.sin(th) + 0.006];
}
export function wgs2bd(lng, lat) {
  const g = wgs2gcj(lng, lat);
  return gcj2bd(g[0], g[1]);
}
