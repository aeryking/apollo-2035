/**
 * 特种车辆俯视图标图集：救护车 / 警车 / 消防车
 *
 * 页面加载时用 Canvas 2D 画成一张 256×256 的图集（无外部图片），上传成 WebGL 纹理。
 * 每格 64×160 像素，车头朝上（纹理 v=0 一侧）；格序与事件图层的种类编号一致：
 *   0 救护车 | 1 警车 | 2 消防车
 * 警灯在图集里画成浅灰；着色器按 LIGHT_RECTS 给出的位置把这块替换成红蓝交替闪烁。
 * （曾用纯绿作标记色、按颜色识别：缩小显示时 mipmap 把绿和车身色混成黄绿，认不全，实测发绿。）
 */
export const ICON_CELL = { w: 64, h: 160 };
export const ATLAS_SIZE = 256;
/**
 * 各车型警灯在本格内的位置：[x0, x1, y0, y1]，单位为格宽 / 格高的比例，y 从车头量起。
 * 与下面绘制代码里的 fillRect 一一对应，改车型图案时要同步改这里。
 */
export const LIGHT_RECTS = [
  [16 / 64, 48 / 64, (14 + 128 * 0.27) / 160, (14 + 128 * 0.27 + 7) / 160],   // 救护车
  [17 / 64, 47 / 64, (22 + 112 * 0.31) / 160, (22 + 112 * 0.31 + 7) / 160],   // 警车
  [14 / 64, 50 / 64, (4 + 152 * 0.17) / 160, (4 + 152 * 0.17 + 7) / 160],     // 消防车
];
const LIGHT = '#d6dae0';     // 警灯底色（着色器按位置替换成闪烁的红蓝）

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** 通用车身：圆角矩形 + 描边 + 前挡风玻璃 + 车身阴影 */
function body(g, ox, { x, y, w, h, fill, glassY = 0.1, glassH = 0.12, r = 10 }) {
  g.save();
  g.translate(ox, 0);
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = 6;
  roundRect(g, x, y, w, h, r);
  g.fillStyle = fill;
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.stroke();
  // 前挡风玻璃
  g.fillStyle = '#1b2633';
  roundRect(g, x + 5, y + h * glassY, w - 10, h * glassH, 5);
  g.fill();
  g.restore();
}

function ambulance(g, ox) {
  const x = 10, y = 14, w = 44, h = 128;
  body(g, ox, { x, y, w, h, fill: '#f4f6f8' });
  g.save();
  g.translate(ox, 0);
  // 红色腰线（两侧）
  g.fillStyle = '#e0262b';
  g.fillRect(x, y + h * 0.42, 4, h * 0.5);
  g.fillRect(x + w - 4, y + h * 0.42, 4, h * 0.5);
  // 车顶红十字
  const cx = x + w / 2, cy = y + h * 0.66;
  g.fillRect(cx - 4, cy - 13, 8, 26);
  g.fillRect(cx - 13, cy - 4, 26, 8);
  // 警灯（驾驶室顶）
  g.fillStyle = LIGHT;
  g.fillRect(x + 6, y + h * 0.27, w - 12, 7);
  g.restore();
}

function police(g, ox) {
  const x = 12, y = 22, w = 40, h = 112;
  body(g, ox, { x, y, w, h, fill: '#f2f5f9', glassY: 0.12, glassH: 0.14, r: 12 });
  g.save();
  g.translate(ox, 0);
  // 蓝色车身条纹 + 后挡风
  g.fillStyle = '#1f4fd1';
  g.fillRect(x, y + h * 0.5, w, 9);
  g.fillStyle = '#1b2633';
  roundRect(g, x + 6, y + h * 0.78, w - 12, h * 0.1, 4);
  g.fill();
  // 车顶「警」
  g.fillStyle = '#1f4fd1';
  g.font = 'bold 20px "PingFang SC","Microsoft YaHei",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('警', x + w / 2, y + h * 0.66);
  // 警灯
  g.fillStyle = LIGHT;
  g.fillRect(x + 5, y + h * 0.31, w - 10, 7);
  g.restore();
}

function fireTruck(g, ox) {
  const x = 8, y = 4, w = 48, h = 152;
  body(g, ox, { x, y, w, h, fill: '#d8231f', glassY: 0.05, glassH: 0.09, r: 8 });
  g.save();
  g.translate(ox, 0);
  // 驾驶室与车厢分界
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(x, y + h * 0.24, w, 3);
  // 车顶云梯（两根纵梁 + 横档）
  g.strokeStyle = '#e8e8e8';
  g.lineWidth = 3;
  const lx0 = x + 12, lx1 = x + w - 12, ly0 = y + h * 0.3, ly1 = y + h * 0.95;
  g.beginPath();
  g.moveTo(lx0, ly0); g.lineTo(lx0, ly1);
  g.moveTo(lx1, ly0); g.lineTo(lx1, ly1);
  for (let yy = ly0 + 6; yy < ly1; yy += 11) { g.moveTo(lx0, yy); g.lineTo(lx1, yy); }
  g.stroke();
  // 警灯
  g.fillStyle = LIGHT;
  g.fillRect(x + 6, y + h * 0.17, w - 12, 7);
  g.restore();
}

/** 画好整张图集，返回 canvas（作为纹理源） */
export function buildVehicleAtlas() {
  const c = document.createElement('canvas');
  c.width = c.height = ATLAS_SIZE;
  const g = c.getContext('2d');
  g.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  ambulance(g, 0);
  police(g, ICON_CELL.w);
  fireTruck(g, ICON_CELL.w * 2);
  return c;
}
