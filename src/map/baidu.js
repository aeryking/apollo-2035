/* 百度地图 JSAPI 4.0 加载、底图氛围与 WebGLLayer 基类访问 */

/** 暗色底图样式：深底、低对比路网，让叠加层发光 */
export const DARK_STYLE = (() => {
  const rgba = (hex) => `${hex}ff`;
  const rows = [
    ['land', 'geometry', '#070b12'],
    ['water', 'geometry', '#08172b'],
    ['green', 'geometry', '#0b1a16'],
    ['building', 'geometry.fill', '#121a28'],
    ['building', 'geometry.stroke', '#1b2434'],
    ['manmade', 'geometry', '#0d1420'],
    ['education', 'geometry', '#0d1622'],
    ['medical', 'geometry', '#0d1622'],
    ['scenicspots', 'geometry', '#0b1a16'],
    ['highway', 'geometry.fill', '#2b3446'],
    ['arterial', 'geometry.fill', '#232c3d'],
    ['local', 'geometry.fill', '#1b2231'],
    ['cityhighway', 'geometry.fill', '#212a3a'],
    ['nationalway', 'geometry.fill', '#212a3a'],
    ['provincialway', 'geometry.fill', '#212a3a'],
    ['tertiaryway', 'geometry.fill', '#212a3a'],
    ['fourlevelway', 'geometry.fill', '#212a3a'],
    ['railway', 'geometry', '#232c3d'],
    ['subway', 'geometry', '#212a3a'],
    ['roadarrow', 'labels.icon', null],
    ['poilabel', 'labels.icon', null],
    ['poilabel', 'labels.text.fill', '#5d6b81'],
    ['poilabel', 'labels.text.stroke', '#070b12'],
    ['road', 'labels.text.fill', '#68758a'],
    ['road', 'labels.text.stroke', '#070b12'],
    ['districtlabel', 'labels.text.fill', '#8b98ac'],
    ['districtlabel', 'labels.text.stroke', '#070b12'],
    ['town', 'labels.text.fill', '#76839a'],
    ['village', 'labels.text.fill', '#5d6b81'],
    ['country', 'labels.text.fill', '#9aa7ba'],
  ];
  return rows.map(([featureType, elementType, color]) => ({
    featureType,
    elementType,
    stylers: color
      ? { visibility: 'on', color: rgba(color) }
      : { visibility: 'off' },
  }));
})();

/**
 * 注入百度地图 JSAPI 4.0（WebGL 内核）。
 * 只有 4.0 才对外暴露 WebGLLayer 体系（WebGLCustomLayer / ThreejsLayer / DeckglLayer …），
 * 默认的 GL 1.0 版本没有这套扩展接口。
 */
export function loadBMap(ak, timeoutMs = 20000) {
  if (window.BMap?.WebGLCustomLayer) return Promise.resolve(window.BMap);
  return new Promise((resolve, reject) => {
    const cb = `__bmap4_${Date.now()}`;
    const timer = setTimeout(
      () => reject(new Error('百度地图 JSAPI 加载超时（检查 AK 与 Referer 白名单）')),
      timeoutMs,
    );
    window[cb] = () => {
      clearTimeout(timer);
      resolve(window.BMap);
    };
    const s = document.createElement('script');
    s.src = `https://api.map.baidu.com/api?v=4.0&type=webgl&ak=${encodeURIComponent(ak)}&callback=${cb}`;
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error('百度地图 JSAPI 脚本加载失败'));
    };
    document.head.appendChild(s);
  });
}

/**
 * 取 WebGLLayer 基类。
 * 原型链实测：WebGLCustomLayer → (K) → (bL = WebGLLayer) → Object
 * 基类在祖父级，带 isWebGLLayer 标记。直接继承它拿原生 gl 上下文，
 * 不受 WebGLCustomLayer 那层"安全 GL 包装"的限制（那层会拦掉 bindBuffer 等动态更新调用）。
 */
export function getWebGLLayerBase() {
  const CC = window.BMap?.WebGLCustomLayer;
  if (!CC) throw new Error('当前 JSAPI 版本未提供 WebGLLayer（需要 v=4.0 且 type=webgl）');
  let p = CC.prototype;
  while (p) {
    const own = (k) => Object.prototype.hasOwnProperty.call(p, k);
    // 基类自己定义了 onAdd / render / getMVPMatrix（子类只继承）
    if (p.isWebGLLayer && own('onAdd') && own('render') && own('getMVPMatrix')) {
      return p.constructor;
    }
    p = Object.getPrototypeOf(p);
  }
  throw new Error('未能定位 WebGLLayer 基类');
}

export function createMap(el, { center = [108.9, 34.2], zoom = 5, style = true } = {}) {
  const map = new BMap.Map(el, { enableBizAuthLogo: false });
  map.centerAndZoom(new BMap.Point(center[0], center[1]), zoom);
  map.enableScrollWheelZoom(true);
  if (style) map.setMapStyleV2({ styleJson: DARK_STYLE });
  map.setDisplayOptions({ indoor: false, poi: false, building: false });
  return map;
}
