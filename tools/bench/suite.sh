#!/bin/zsh
# 浏览器对照测试套件：Safari / Chrome（限帧）/ Chrome（不限帧），空地图与 30 万 / 100 万 / 200 万辆
# 前提：tools/serve.py 在 4180 端口提供生产构建
cd "$(dirname "$0")/../.."
B="${BASE:-http://localhost:4180}"
OUT=docs/bench/inbox
SUM=docs/bench/inbox/suite-$(date +%m%d-%H%M).tsv
echo -e "tag\tbrowser\tfps\tp50\tp95\tmax\tourCpuMs\tgpuMs\tlodK\tswapMB\tload" > "$SUM"
row() {
  local tag=$1
  python3 - "$OUT/fps-$tag.json" "$2" "$3" >> "$SUM" <<'PY'
import json, sys
try:
    r = json.load(open(sys.argv[1]))
    print('\t'.join(str(x) for x in [r['tag'], r.get('browser', 'safari' if 'Safari/605' in r.get('ua', '') else 'chrome'), r['fps'], r['p50'], r['p95'], r['max'], r.get('ourCpuMs'), r.get('gpuMs'), r.get('lodK'), sys.argv[2], sys.argv[3]]))
except Exception as e:
    print(f"{sys.argv[1]}\t失败\t{e}")
PY
}
state() { SWAP=$(sysctl -n vm.swapusage | awk '{print $6}' | tr -d M); LOAD=$(uptime | awk -F'averages: ' '{print $2}' | cut -d' ' -f1); }
sf()  { state; tools/bench/safari-real.sh "$B/$1" "fps-$2.json" ${3:-120} > /dev/null; row $2 $SWAP $LOAD; tail -1 "$SUM"; }
cr()  { state; tools/bench/chrome-real.sh "$B/$1" "fps-$2.json" ${3:-120} > /dev/null; row $2 $SWAP $LOAD; tail -1 "$SUM"; }
cru() { state; UNCAPPED=1 tools/bench/chrome-real.sh "$B/$1" "fps-$2.json" ${3:-120} > /dev/null; row $2 $SWAP $LOAD; tail -1 "$SUM"; }

AK="${AK:-$(sed -n 's/^VITE_BAIDU_AK=//p' .env.local 2>/dev/null)}"
BARE="tools/probe/bare.html?zoom=5&lng=108.9&lat=34.2&ak=$AK"
sf  "$BARE&fpsdl=Q-SF-bare"                     Q-SF-bare
cr  "$BARE&fpsdl=Q-CR-bare"                     Q-CR-bare
for n in 300000 1000000 2000000; do
  k=$((n/10000))w
  sf  "?fleet=$n&fpsdl=Q-SF-$k&warm=25"         Q-SF-$k
  cr  "?fleet=$n&fpsdl=Q-CR-$k&warm=25"         Q-CR-$k
  cru "?fleet=$n&fpsdl=Q-CU-$k&warm=25"         Q-CU-$k
done
echo "汇总：$SUM"
