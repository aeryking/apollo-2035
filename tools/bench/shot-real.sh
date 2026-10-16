#!/bin/zsh
# 真实 Chrome 窗口截图（macOS screencapture）：<url> <输出前缀> <秒,秒,...>
URL="$1"; OUT="$2"; TIMES="${3:-3,12}"
PROFILE=/tmp/a35chrome-shot-$$
mkdir -p "$PROFILE/Default"
echo '{"translate":{"enabled":false},"browser":{"has_seen_welcome_page":true}}' > "$PROFILE/Default/Preferences"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  --disable-features=Translate,TranslateUI --lang=zh-CN --window-size=1470,880 --window-position=0,25 "$URL" >/dev/null 2>&1 &
PID=$!
prev=0
for t in ${(s:,:)TIMES}; do
  sleep $((t - prev)); prev=$t
  screencapture -x -R0,25,1470,880 "${OUT}-${t}s.png"
  echo "${OUT}-${t}s.png"
done
kill $PID 2>/dev/null; sleep 1; pkill -f "user-data-dir=$PROFILE" 2>/dev/null; rm -rf "$PROFILE"
