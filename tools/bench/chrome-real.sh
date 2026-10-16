#!/bin/zsh
# 以「普通用户」方式启动独立 Chrome（临时配置目录，无自动化、无调试协议），
# 页面结束后把结果下载到 $DL；脚本等待结果文件出现后关闭这个 Chrome 实例。
# 用法：tools/bench/chrome-real.sh <url> <期望的结果文件名> [超时秒]
# 注：关闭了 Chrome「节能模式」（电池电量 ≤20% 时它会把帧率锁在 30 FPS），
#     但 macOS 本身在低电量时仍可能降频，正式测试请接通电源。
URL="$1"; WANT="$2"; TIMEOUT="${3:-240}"
PROFILE=/tmp/a35chrome
DL=/tmp/a35probe/dl
INBOX="$(cd "$(dirname "$0")/../.." && pwd)/docs/bench/inbox"   # 页面优先把结果 POST 回服务器
mkdir -p "$PROFILE/Default" "$DL" "$INBOX"
rm -f "$DL/$WANT" "$INBOX/$WANT"
cat > "$PROFILE/Default/Preferences" <<JSON
{"download":{"default_directory":"$DL","prompt_for_download":false,"directory_upgrade":true},"profile":{"exit_type":"Normal","exited_cleanly":true},"browser":{"has_seen_welcome_page":true},"performance_tuning":{"battery_saver_mode":{"state":0},"high_efficiency_mode":{"state":0}}}
JSON
# UNCAPPED=1：关闭垂直同步与帧率上限，测「不受显示器刷新率限制」的真实帧率（性能余量）
EXTRA=()
if [ -n "$UNCAPPED" ]; then EXTRA=(--disable-gpu-vsync --disable-frame-rate-limit); fi
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check "${EXTRA[@]}" \
  --disable-features=DownloadBubble,DownloadBubbleV2,BatterySaverModeAvailable,HighEfficiencyModeAvailable \
  --window-size=1600,900 --window-position=40,40 "$URL" >/dev/null 2>&1 &
PID=$!
for i in $(seq 1 $TIMEOUT); do
  if [ -f "$INBOX/$WANT" ]; then cp "$INBOX/$WANT" "$DL/$WANT"; break; fi
  if [ -f "$DL/$WANT" ]; then break; fi
  sleep 1
done
kill $PID 2>/dev/null; sleep 1; pkill -f "user-data-dir=$PROFILE" 2>/dev/null
if [ -f "$DL/$WANT" ]; then cat "$DL/$WANT"; echo; else echo "超时：未得到 $WANT"; fi
