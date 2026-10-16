/**
 * 画面快照（调试/文档用）：在所有图层画完后读取 WebGL 帧缓冲，编码为 PNG 回传开发服务器。
 * 不依赖系统截屏权限；只包含 WebGL 画面（底图 + 本项目图层），不含 HTML 面板。
 * 用法：?snap=名称@秒,名称@秒   例：?snap=nation@3,nation2@15
 */
import { BaseLayer } from './base.js';

export class SnapLayer extends BaseLayer {
  constructor(opts = {}) {
    super({ zIndex: 99, ...opts });
    this.queue = [];
  }

  request(name) { this.queue.push(name); }

  onFrame(gl) {
    if (!this.queue.length) return;
    const name = this.queue.shift();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // 异步编码，避免占用当前帧
    setTimeout(() => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      const img = g.createImageData(w, h);
      for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;   // 帧缓冲 alpha 不代表可见度，统一不透明
      g.putImageData(img, 0, 0);
      c.toBlob((b) => fetch(`/__bench/save?name=${encodeURIComponent(name)}.png`, { method: 'POST', body: b }), 'image/png');
    }, 0);
  }
}
