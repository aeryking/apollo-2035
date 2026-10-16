/**
 * 流式解析 Worker。
 * 职责：发起请求 → 分块读取 → 增量解析帧 → 把帧的 ArrayBuffer 转移给主线程。
 * 主线程零解析开销，只做显存上传，因此加载过程中地图交互不受影响。
 */
import { FrameParser, KIND } from './binary.js';

const KIND_NAME = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k.toLowerCase()]));

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.cmd !== 'fetch') return;
  const { url, kind, token, priority } = msg;
  try {
    const res = await fetch(url, { priority, credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const parser = new FrameParser();
    let received = 0;
    let frames = 0;
    const t0 = performance.now();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      // 解析出所有完整帧，逐个转移给主线程
      for (const f of parser.push(value)) {
        frames++;
        self.postMessage(
          { t: 'frame', kind, kindName: KIND_NAME[kind] || String(kind), type: f.type, payload: f.payload, header: parser.header },
          [f.payload],
        );
      }
      // 每积累 256KB 报一次进度，避免消息风暴
      if (received % 262144 < value.byteLength) {
        self.postMessage({ t: 'progress', kind, received, total, frames, ms: performance.now() - t0 });
      }
    }
    self.postMessage({
      t: 'done', kind, token, received, frames,
      ms: performance.now() - t0,
      header: parser.header,
      pending: parser.pending,
      mbps: received / 1048576 / ((performance.now() - t0) / 1000),
    });
  } catch (e) {
    self.postMessage({ t: 'error', kind, token, message: String(e && e.message) });
  }
};
