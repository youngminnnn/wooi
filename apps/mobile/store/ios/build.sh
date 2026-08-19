#!/usr/bin/env bash
#
# App Store 등록정보 자산을 SVG 에서 다시 만든다.
#
#   ./build.sh
#
# 산출물(icon-1024.png)도 커밋한다. 스토어에 올리는 것은 PNG 이고, 렌더링 환경(rsvg 버전,
# 설치된 폰트)에 따라 결과가 달라질 수 있어서 "무엇을 올렸는지" 가 레포에 남아 있어야 한다.
#
# 그림 원본과 PNG 재인코더는 **Play 쪽 것을 그대로 쓴다**(`../android/src/`). 두 스토어가
# 요구하는 것은 같은 마크이고 다른 것은 래스터 규격뿐이다 — 512 vs 1024, 알파 있음 vs 없음.
# SVG 를 한 벌 더 두면 한쪽만 고쳐지고, 그때 두 스토어의 아이콘이 말없이 갈린다.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v rsvg-convert >/dev/null; then
  echo "rsvg-convert 가 없습니다 — brew install librsvg" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# App Store 아이콘은 1024×1024 이고 **알파 채널이 있으면 거부된다.** rsvg-convert 는 그림이
# 전부 불투명하면 알파를 떼고 24비트로 내보내지만, 그건 보장이 아니라 우연이다 — 명시적으로
# 맞춘다(Play 쪽은 반대로 32비트를 요구해서 같은 도구가 양방향으로 쓰인다).
rsvg-convert --width 1024 --height 1024 ../shared/icon.svg --output "$tmp/icon.png"
python3 ../shared/png-recode.py "$tmp/icon.png" icon-1024.png rgb

echo
echo "만들어진 자산:"
python3 - <<'PY'
import struct

data = open("icon-1024.png", "rb").read()
w, h, depth, color = struct.unpack(">IIBB", data[16:26])
bits = {2: 24, 6: 32}[color]
ok = "OK" if (w, h, color) == (1024, 1024, 2) else "규격 불일치!"
print(f"  icon-1024.png          {w}x{h}  {bits}비트  {len(data):,} bytes  {ok}")
PY
