import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 测试结果回收端（仅开发服务器）：页面测完后 POST /__bench/save?name=xxx，
 * 结果写入 docs/bench/inbox/。任何浏览器都能用 —— Safari 不必弹下载确认，
 * 局域网里的 Windows 机器也能把结果直接送回来。
 */
function benchSink() {
  const dir = path.resolve('docs/bench/inbox');
  return {
    name: 'a35-bench-sink',
    configureServer(server) {
      server.middlewares.use('/__bench/save', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        const name = (new URL(req.url, 'http://x').searchParams.get('name') || `result-${Date.now()}`)
          .replace(/[^\w.\-一-龥]/g, '_').slice(0, 120);
        const chunks = [];
        let size = 0;
        req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 60e6) req.destroy(); });
        req.on('end', () => {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks));
          res.setHeader('access-control-allow-origin', '*');
          res.end('ok');
        });
      });
    },
  };
}

// 线程间数据用可转移 ArrayBuffer 零拷贝传递，不依赖 SharedArrayBuffer，
// 因此不需要 COOP/COEP 跨源隔离响应头（百度地图脚本与瓦片均为跨域资源，开启隔离会增加兼容风险）。
export default defineConfig({
  plugins: [benchSink()],
  server: { port: 5173, host: true },
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
});
