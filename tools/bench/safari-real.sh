#!/bin/zsh
# 用 macOS 自带的 Safari 打开测试页（用户真实会话，无任何自动化），
# 页面测完后把结果 POST 回开发服务器，写入 docs/bench/inbox/<结果文件名>。
# 用法：tools/bench/safari-real.sh <url> <结果文件名> [超时秒]
URL="$1"; WANT="$2"; TIMEOUT="${3:-240}"
INBOX="$(cd "$(dirname "$0")/../.." && pwd)/docs/bench/inbox"
mkdir -p "$INBOX"
rm -f "$INBOX/$WANT"
open -a Safari "$URL"
for i in $(seq 1 $TIMEOUT); do
  [ -f "$INBOX/$WANT" ] && break
  sleep 1
done
# 关闭本次打开的测试标签页（首次运行时 macOS 可能询问是否允许控制 Safari，拒绝也不影响结果）
osascript -e 'tell application "Safari" to close (every tab of every window whose URL contains "fpsdl=" or URL contains "autodl=")' >/dev/null 2>&1
if [ -f "$INBOX/$WANT" ]; then cat "$INBOX/$WANT"; echo; else echo "超时：未得到 $WANT"; fi
