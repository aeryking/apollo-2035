#!/bin/zsh
# 纯渲染上限：静态车辆（不启动仿真 Worker），只开车辆图层，全国视角
cd "$(dirname "$0")/../.."
B="${BASE:-http://localhost:4180}"
SUM=docs/bench/inbox/stress-$(date +%m%d-%H%M).tsv
echo -e "tag\tbrowser\tfps\tp50\tp95\tmax\tourCpuMs\tgpuMs\tlodK\tswapMB\tload" > "$SUM"
row() { python3 - "docs/bench/inbox/fps-$1.json" "$2" "$3" >> "$SUM" <<'PY'
import json, sys
try:
    r = json.load(open(sys.argv[1]))
    print('\t'.join(str(x) for x in [r['tag'], r.get('browser'), r['fps'], r['p50'], r['p95'], r['max'], r.get('ourCpuMs'), r.get('gpuMs'), r.get('lodK'), sys.argv[2], sys.argv[3]]))
except Exception as e:
    print(f"{sys.argv[1]}\t失败\t{e}")
PY
}
state() { SWAP=$(sysctl -n vm.swapusage | awk '{print $6}' | tr -d M); LOAD=$(uptime | awk -F'averages: ' '{print $2}' | cut -d' ' -f1); }
for n in ${=SIZES:-2000000 4000000 8000000}; do
  k=$((n/10000))w
  for b in ${=BROWSERS:-safari chrome}; do
    state
    if [ $b = safari ]; then tools/bench/safari-real.sh "$B/?stress=$n&fleet=$n&roads=0&zones=0&fpsdl=Z-SF-$k&warm=25" "fps-Z-SF-$k.json" 150 > /dev/null; row Z-SF-$k $SWAP $LOAD
    else tools/bench/chrome-real.sh "$B/?stress=$n&fleet=$n&roads=0&zones=0&fpsdl=Z-CR-$k&warm=25" "fps-Z-CR-$k.json" 150 > /dev/null; row Z-CR-$k $SWAP $LOAD; fi
    tail -1 "$SUM"
  done
done
echo "汇总：$SUM"
