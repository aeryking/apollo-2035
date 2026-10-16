#!/bin/zsh
# 真实浏览器分层对照：同一视角下分别打开不同图层组合，比较帧率
B="http://localhost:5173"
run() { tools/bench/chrome-real.sh "$1" "fps-$2.json" 90 | tail -1; }
AK="${AK:-$(sed -n 's/^VITE_BAIDU_AK=//p' .env 2>/dev/null)}"
run "$B/tools/probe/bare.html?zoom=5&lng=108.9&lat=34.2&ak=$AK&fpsdl=L0-bare" L0-bare
run "$B/?start=0&roads=0&zones=0&fpsdl=L1-app-empty&warm=12" L1-app-empty
run "$B/?start=0&roads=0&zones=1&fpsdl=L2-zones&warm=12" L2-zones
run "$B/?start=0&roads=1&zones=0&fpsdl=L3-roads&warm=12" L3-roads
run "$B/?fleet=1000000&roads=0&zones=0&fpsdl=L4-cars1m&warm=15" L4-cars1m
run "$B/?fleet=1000000&fpsdl=L5-all1m&warm=15" L5-all1m
