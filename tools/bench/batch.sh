#!/bin/zsh
# 批量帧率测试：每行「标签 | 是否不限帧率(0/1) | URL」，结果 JSON 汇总到 $OUT
# 用法：tools/bench/batch.sh <清单文件> [输出目录]
LIST="$1"; OUT="${2:-docs/bench/real-chrome/raw}"
mkdir -p "$OUT"
while IFS='|' read -r tag unc url; do
  tag="${tag// /}"; unc="${unc// /}"; url="${url## }"
  [[ -z "$tag" || "$tag" == \#* ]] && continue
  if [[ "$url" == *"fpsdl="* ]]; then want="fps-$tag.json"; else want="bench-$tag.json"; fi
  if [ "$unc" = "1" ]; then res=$(UNCAPPED=1 tools/bench/chrome-real.sh "$url" "$want" 300 | tail -1); else res=$(tools/bench/chrome-real.sh "$url" "$want" 300 | tail -1); fi
  cp "/tmp/a35probe/dl/$want" "$OUT/" 2>/dev/null
  [[ "$want" == bench-* ]] && cp "/tmp/a35probe/dl/bench-$tag.md" "$OUT/" 2>/dev/null
  echo "$(date +%H:%M:%S) [$tag] ${res:0:300}"
  sleep 3
done < "$LIST"
