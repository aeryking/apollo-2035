/**
 * 区域面解析 Worker：流式读取 GeoJSON/NDJSON → 坐标转换 → 三角化 → 交给主线程上显存
 *
 * 这是「边下载、边解析、边显示」最典型的环节：
 *   fetch ReadableStream 分块读取 → 逐条 Feature 解析 → earcut 三角化
 *   → 每算完一批就 postMessage 转移（零拷贝），主线程立刻就能画出这一块。
 * 全程不碰主线程，所以地图交互不受影响。
 */
import earcut from 'earcut';
import { ll2mc, BASE_MC, gcj2bd, wgs2bd } from '../core/projection.js';

const mc = [0, 0];

/** GeoJSON 环 → 三角化，输出 [x, y, zoneId, value] × n */
function triangulateFeature(feature, zoneId, value, origin, out, fill = true) {
  const geom = feature.geometry;
  if (!geom) return;
  const polys = geom.type === 'Polygon' ? [geom.coordinates]
    : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const poly of polys) {
    for (let r = 0; r < poly.length; r++) {
      const ring = poly[r];
      if (ring.length < 3) continue;
      const flat = [];
      ll2mc(ring[0][0], ring[0][1], mc);
      // 外环反向、内环正向（GeoJSON 约定），这里统一转成图层绝对坐标
      for (let i = 0; i < ring.length; i++) {
        const [lng, lat] = ring[i];
        ll2mc(lng, lat, mc);
        flat.push(mc[0] - BASE_MC[0], mc[1] - BASE_MC[1]);
      }
      // 去掉闭合重复点，提升 earcut 稳定性
      if (flat.length >= 4 && flat[0] === flat[flat.length - 2] && flat[1] === flat[flat.length - 1]) {
        flat.length -= 2;
      }
      const n = flat.length / 2;
      if (n < 3) continue;
      const idx = fill ? earcut(flat) : [];
      if (r === 0 && fill) {
        for (let t = 0; t < idx.length; t++) {
          const v = idx[t];
          out.push(flat[v * 2], flat[v * 2 + 1], zoneId, value);
        }
      }
      // 内外环都额外输出一圈描边（LINES 模式）
      if (out.__lines) {
        for (let i = 0; i < ring.length - 1; i++) {
          ll2mc(ring[i][0], ring[i][1], mc);
          const x0 = mc[0] - BASE_MC[0], y0 = mc[1] - BASE_MC[1];
          ll2mc(ring[i + 1][0], ring[i + 1][1], mc);
          out.__lines.push(x0, y0, zoneId, value, mc[0] - BASE_MC[0], mc[1] - BASE_MC[1], zoneId, value);
        }
      }
    }
  }
}

self.onmessage = async (ev) => {
  const { cmd, url, coord, zoneKey = 'adcode' } = ev.data || {};
  if (cmd !== 'zones') return;
  const t0 = performance.now();
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let features = 0;
    let totalTris = 0;
    let pendingFill = [];
    let pendingLine = [];
    const toBd = coord === 'wgs84' ? wgs2bd : coord === 'gcj02' ? gcj2bd : (a, b) => [a, b];
    let zoneId = 0;

    const flush = (force) => {
      if (pendingFill.length >= 60000 || force) {
        if (pendingFill.length) {
          self.postMessage({ t: 'fill', data: new Float32Array(pendingFill).buffer, count: pendingFill.length / 4 }, [new Float32Array(pendingFill).buffer]);
          pendingFill = [];
        }
      }
      if (pendingLine.length >= 40000 || force) {
        if (pendingLine.length) {
          self.postMessage({ t: 'line', data: new Float32Array(pendingLine).buffer, count: pendingLine.length / 4 }, [new Float32Array(pendingLine).buffer]);
          pendingLine = [];
        }
      }
    };

    // 逐块解析：按行切 NDJSON，或整体 JSON 时按 Feature 边界切
    let streamedFeatures = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let f;
        try { f = JSON.parse(line); } catch { continue; }
        const items = f.type === 'FeatureCollection' ? f.features : f.type === 'Feature' ? [f] : [];
        for (const feat of items) {
          const zid = zoneId++;
          const val = 0.35 + ((feat.properties?.[zoneKey] ?? 0) % 100) / 160;
          // 坐标转换由 ll2mc 完成（DataV 为 GCJ02，先转 BD09）
          if (coord && coord !== 'bd09') {
            const conv = (ring) => ring.map(([a, b]) => { const c = toBd(a, b); return c; });
            if (feat.geometry?.type === 'Polygon') feat.geometry.coordinates = feat.geometry.coordinates.map(conv);
            else if (feat.geometry?.type === 'MultiPolygon') feat.geometry.coordinates = feat.geometry.coordinates.map((p) => p.map(conv));
          }
          pendingFill.__lines = pendingLine;
          // 省级面只出描边：地级市面已经铺满全国，再填一遍省会让整片国土重复混合
          const isProvince = feat.properties?.level === 'province';
          triangulateFeature(feat, zid, val, null, pendingFill, !isProvince);
          features++;
          streamedFeatures++;
        }
        flush(false);
      }
      if (buf.length > 4_000_000) break; // 保险：单行超长时放弃
    }
    // 整体 JSON（非 NDJSON）兜底
    if (!features && buf.trim()) {
      try {
        const j = JSON.parse(buf);
        const items = j.type === 'FeatureCollection' ? j.features : [j];
        for (const feat of items) {
          const zid = zoneId++;
          pendingFill.__lines = pendingLine;
          triangulateFeature(feat, zid, 0.5, null, pendingFill);
          features++;
        }
      } catch (e) { /* ignore */ }
    }
    flush(true);
    self.postMessage({ t: 'done', features, ms: performance.now() - t0 });
  } catch (e) {
    self.postMessage({ t: 'error', message: String(e && e.message) });
  }
};
