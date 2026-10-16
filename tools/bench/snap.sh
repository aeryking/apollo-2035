#!/bin/zsh
# 用普通 Chrome 打开页面并按 ?snap= 自截图（不触发系统截屏授权）；等待全部 PNG 到达后关闭
# 用法：tools/bench/snap.sh "<url（不含 snap 参数）>" "名称@秒,名称@秒"
URL="$1"; SNAPS="$2"
INBOX="$(cd "$(dirname "$0")/../.." && pwd)/docs/bench/inbox"
PROFILE=/tmp/a35chrome-snap-$$
mkdir -p "$PROFILE/Default"
echo '{"translate":{"enabled":false},"browser":{"has_seen_welcome_page":true}}' > "$PROFILE/Default/Preferences"
names=(); maxt=0
for item in ${(s:,:)SNAPS}; do n=${item%@*}; t=${item#*@}; names+=$n; rm -f "$INBOX/$n.png"; (( t > maxt )) && maxt=$t; done
SEP='?'; [[ "$URL" == *\?* ]] && SEP='&'
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  --disable-features=Translate,TranslateUI --window-size=1470,880 --window-position=0,25 "${URL}${SEP}snap=${SNAPS}" >/dev/null 2>&1 &
PID=$!
for i in $(seq 1 $((maxt + 30))); do
  all=1; for n in $names; do [ -f "$INBOX/$n.png" ] || all=0; done
  [ $all = 1 ] && break; sleep 1
done
sleep 1; kill $PID 2>/dev/null; sleep 1; pkill -f "user-data-dir=$PROFILE" 2>/dev/null; rm -rf "$PROFILE"
for n in $names; do ls -la "$INBOX/$n.png" 2>/dev/null || echo "缺少 $n.png"; done
