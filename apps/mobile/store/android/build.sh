#!/usr/bin/env bash
#
# Play 스토어 등록정보 자산을 src/ 의 SVG 에서 다시 만든다.
#
#   ./build.sh
#
# 산출물(icon-512.png, feature-graphic.png)도 커밋한다. 스토어에 올리는 것은 PNG 이고,
# 렌더링 환경(rsvg 버전, 설치된 폰트)에 따라 결과가 달라질 수 있어서 "무엇을 올렸는지" 가
# 레포에 남아 있어야 한다.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v rsvg-convert >/dev/null; then
  echo "rsvg-convert 가 없습니다 — brew install librsvg" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# rsvg-convert 는 그림이 전부 불투명하면 알파 채널을 떼고 24비트로 내보낸다. Play 는 아이콘에
# 32비트(알파 포함)를, 피처 그래픽에 24비트(알파 없음)를 요구하므로 양쪽 다 채널을 맞춘다.
rsvg-convert --width 512 --height 512 src/icon.svg --output "$tmp/icon.png"
python3 src/png-recode.py "$tmp/icon.png" icon-512.png rgba

rsvg-convert --width 1024 --height 500 src/feature-graphic.svg --output "$tmp/feature.png"
python3 src/png-recode.py "$tmp/feature.png" feature-graphic.png rgb

echo
echo "만들어진 자산:"
python3 - <<'PY'
import struct
for name, want in (("icon-512.png", 6), ("feature-graphic.png", 2)):
    data = open(name, "rb").read()
    w, h, depth, color = struct.unpack(">IIBB", data[16:26])
    bits = {2: 24, 6: 32}[color]
    ok = "OK" if color == want else "규격 불일치!"
    print(f"  {name:<22} {w}x{h}  {bits}비트  {len(data):,} bytes  {ok}")
PY
