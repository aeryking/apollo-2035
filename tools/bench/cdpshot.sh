#!/bin/zsh
# 真实时钟截图：无头 Chrome 打开页面，等 N 秒（真实时间）后经 DevTools 协议截一张。
# 与 hudshot.sh 的区别：hudshot 用虚拟时间快进，页面里按 performance.now() 算的
# 速率类指标（加载吞吐等）会失真；这里的数字与真实浏览器一致。
# 用法：tools/bench/cdpshot.sh <url> <输出png|-> [WxH] [等待秒] [JS 表达式]
URL="$1"; OUT="$2"; SIZE="${3:-1470x880}"; WAIT="${4:-10}"; EXPR="$5"
W=${SIZE%x*}; H=${SIZE#*x}; PORT=$((9500 + $$ % 300)); PROFILE=/tmp/a35cdp-$$
mkdir -p "$PROFILE/Default"
echo '{"translate":{"enabled":false}}' > "$PROFILE/Default/Preferences"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --user-data-dir="$PROFILE" --no-first-run --disable-features=Translate --hide-scrollbars \
  --force-device-scale-factor=1 --window-size="$W,$H" "--screen-info={${W}x${H}}" \
  --remote-debugging-port=$PORT "$URL" >/dev/null 2>&1 &
# 先等调试端口就绪（Chrome 冷启动时间不定），再从「端口就绪」起计 WAIT 秒
WSURL=""
for i in $(seq 1 60); do
  WSURL=$(curl -s --noproxy '*' "http://127.0.0.1:$PORT/json/list" 2>/dev/null | python3 -c "import json,sys
try: print([t for t in json.load(sys.stdin) if t['type']=='page'][0]['webSocketDebuggerUrl'])
except Exception: pass" 2>/dev/null)
  [ -n "$WSURL" ] && break; sleep 0.25
done
[ -z "$WSURL" ] && { echo "调试端口未就绪"; pkill -f "user-data-dir=$PROFILE"; rm -rf "$PROFILE"; exit 1; }
sleep "$WAIT"
node "$(dirname "$0")/cdpshot.mjs" "$WSURL" "$OUT" "$EXPR"
pkill -f "user-data-dir=$PROFILE" 2>/dev/null; sleep 0.5; rm -rf "$PROFILE"
