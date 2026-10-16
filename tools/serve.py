"""
生产构建静态服务（原生 arm64 Python，不经 Rosetta）+ 测试结果回收端。

用法：python3 tools/serve.py [端口=4180] [目录=dist]
  GET  /...                         静态文件（dist/）
  GET  /tools/probe/*.html          测试探针页（项目内）
  POST /__bench/save?name=xxx       测试结果写入 docs/bench/inbox/xxx
"""
import http.server, os, sys, urllib.parse, re, functools

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4180
DIST = os.path.join(ROOT, sys.argv[2] if len(sys.argv) > 2 else 'dist')
INBOX = os.path.join(ROOT, 'docs', 'bench', 'inbox')

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
                      '.ndjson': 'application/x-ndjson', '.bin': 'application/octet-stream'}

    def translate_path(self, path):
        p = urllib.parse.urlparse(path).path
        if p.startswith('/tools/probe/'):
            return os.path.join(ROOT, p.lstrip('/'))
        return super().translate_path(path)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != '/__bench/save':
            self.send_error(404); return
        name = urllib.parse.parse_qs(u.query).get('name', ['result.json'])[0]
        name = re.sub(r'[^\w.\-一-龥]', '_', name)[:120]
        n = int(self.headers.get('content-length') or 0)
        body = self.rfile.read(n) if n else b''
        os.makedirs(INBOX, exist_ok=True)
        with open(os.path.join(INBOX, name), 'wb') as f:
            f.write(body)
        self.send_response(200); self.send_header('access-control-allow-origin', '*'); self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *a):  # 安静
        pass

if __name__ == '__main__':
    os.chdir(DIST)
    srv = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), functools.partial(Handler, directory=DIST))
    print(f'serving {DIST} on :{PORT}  (inbox: {INBOX})', flush=True)
    srv.serve_forever()
