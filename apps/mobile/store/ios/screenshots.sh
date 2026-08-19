#!/usr/bin/env bash
#
# App Store 스크린샷을 iOS 시뮬레이터에서 받아 규격을 확인한다.
#
#   ./screenshots.sh capture iphone 01-workspaces   # 지금 화면을 raw/iphone/01-workspaces.png 로
#   ./screenshots.sh capture ipad   01-workspaces
#   ./screenshots.sh build                          # raw/ → screenshots/ (정확한 규격, 알파 없음)
#
# Play 쪽과 결정적으로 다른 점: **후처리가 필요 없다.** Apple 은 픽셀 크기를 정확히 요구하고
# (1픽셀도 어긋나면 거부), 시뮬레이터가 바로 그 크기로 찍어 준다. 안드로이드는 실기기 화면비가
# 2:1 을 넘어서 무엇을 찍든 캔버스에 다시 앉혀야 했지만, 여기서는 기기만 맞으면 끝이다.
#
# 그래서 `build` 가 하는 일은 두 가지뿐이다 — 크기 검증과 알파 채널 제거. 크기가 어긋난 입력이
# 들어오면 비율을 유지한 채 규격 캔버스에 앉힌다(잘라내지 않는다). 안전망이지 정상 경로가 아니다.
set -euo pipefail

cd "$(dirname "$0")"

BACKGROUND='#13161c' # src/theme 의 앱 배경과 같은 값

# 기기 이름은 Xcode 버전마다 바뀐다. 규격을 만족하는 다른 기기를 쓰려면 환경변수로 덮어쓴다.
IPHONE_DEVICE="${IPHONE_DEVICE:-iPhone 17 Pro Max}"
IPAD_DEVICE="${IPAD_DEVICE:-iPad Pro 13-inch (M5)}"

# 2026-08 기준 App Store 필수 규격.
#   - iPhone 6.9"  1320×2868 — 이것만 올리면 Apple 이 작은 화면용으로 자동 축소한다
#   - iPad  13"    2064×2752 — app.json 의 supportsTablet 이 true 라 **필수**다.
#                              iPhone 것만 올리면 제출 자체가 막힌다.
IPHONE_W=1320
IPHONE_H=2868
IPAD_W=2064
IPAD_H=2752

usage() {
  sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

# 기기 이름 → UDID. 부팅돼 있지 않으면 부팅한다.
device_udid() {
  local name="$1" udid
  udid="$(xcrun simctl list devices available --json |
    python3 -c "
import json, sys
name = sys.argv[1]
data = json.load(sys.stdin)['devices']
for runtime in sorted(data, reverse=True):   # 최신 런타임 우선
    for d in data[runtime]:
        if d['name'] == name:
            print(d['udid'], d['state'])
            raise SystemExit
" "$name")"
  if [ -z "$udid" ]; then
    echo "시뮬레이터 '$name' 이 없습니다. Xcode 에서 받거나 IPHONE_DEVICE/IPAD_DEVICE 로 지정하세요." >&2
    exit 1
  fi
  local id state
  read -r id state <<<"$udid"
  if [ "$state" != "Booted" ]; then
    xcrun simctl boot "$id"
    sleep 8
  fi
  echo "$id"
}

capture() {
  local class="${1:-}" name="${2:-}"
  [ -n "$class" ] && [ -n "$name" ] || usage
  local device
  case "$class" in
    iphone) device="$IPHONE_DEVICE" ;;
    ipad) device="$IPAD_DEVICE" ;;
    *) echo "기기 종류는 iphone 또는 ipad 입니다." >&2; exit 1 ;;
  esac
  local udid
  udid="$(device_udid "$device")"
  mkdir -p "raw/$class"
  # simctl 은 성공해도 "No display specified" 같은 안내를 stderr 로 흘린다. 실패했을 때만 보여 준다.
  local err
  if ! err="$(xcrun simctl io "$udid" screenshot "raw/$class/$name.png" 2>&1 >/dev/null)"; then
    echo "$err" >&2
    exit 1
  fi
  printf 'raw/%s/%s.png  ' "$class" "$name"
  sips -g pixelWidth -g pixelHeight "raw/$class/$name.png" | tail -2 | tr -d ' ' | tr '\n' ' '
  echo
}

# 비율을 유지한 채 규격 캔버스에 앉히고 24비트로 다시 쓴다.
fit() {
  local src="$1" out="$2" cw="$3" ch="$4" tmp="$5"
  local w h dw dh dx dy
  w="$(sips -g pixelWidth "$src" | tail -1 | tr -dc 0-9)"
  h="$(sips -g pixelHeight "$src" | tail -1 | tr -dc 0-9)"
  read -r dw dh dx dy < <(python3 -c "
w, h = $w, $h
s = min($cw / w, $ch / h)
dw, dh = w * s, h * s
print(f'{dw:.2f} {dh:.2f} {($cw - dw) / 2:.2f} {($ch - dh) / 2:.2f}')
")
  {
    printf '<svg width="%s" height="%s" xmlns="http://www.w3.org/2000/svg">' "$cw" "$ch"
    printf '<rect width="%s" height="%s" fill="%s"/>' "$cw" "$ch" "$BACKGROUND"
    printf '<image x="%s" y="%s" width="%s" height="%s" href="data:image/png;base64,' "$dx" "$dy" "$dw" "$dh"
    base64 -i "$src" | tr -d '\n'
    printf '"/></svg>'
  } >"$tmp/frame.svg"

  rsvg-convert -w "$cw" -h "$ch" "$tmp/frame.svg" -o "$tmp/frame.png"
  python3 ../shared/png-recode.py "$tmp/frame.png" "$out" rgb
  local note=""
  [ "$w" = "$cw" ] && [ "$h" = "$ch" ] || note="  (규격이 아니어서 캔버스에 앉힘)"
  printf '  %-42s %sx%s → %sx%s%s\n' "$out" "$w" "$h" "$cw" "$ch" "$note"
}

build() {
  command -v rsvg-convert >/dev/null || { echo "rsvg-convert 가 없습니다 — brew install librsvg" >&2; exit 1; }
  shopt -s nullglob
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  local found=0
  for class in iphone ipad; do
    local files=("raw/$class"/*.png)
    [ ${#files[@]} -gt 0 ] || continue
    found=1
    local cw ch dir
    if [ "$class" = iphone ]; then
      cw=$IPHONE_W ch=$IPHONE_H dir="screenshots/iphone-6.9"
    else
      cw=$IPAD_W ch=$IPAD_H dir="screenshots/ipad-13"
    fi
    mkdir -p "$dir"
    for src in "${files[@]}"; do
      fit "$src" "$dir/$(basename "$src")" "$cw" "$ch" "$tmp"
    done
  done

  if [ "$found" -eq 0 ]; then
    echo "raw/ 에 PNG 이 없습니다. 먼저 './screenshots.sh capture <iphone|ipad> <이름>' 으로 받으세요." >&2
    exit 1
  fi

  echo
  echo "App Store 는 기기 종류마다 최소 1장, 최대 10장을 받습니다."
  echo "supportsTablet 이 true 이므로 iPad 13\" 도 최소 1장 있어야 제출이 열립니다."
}

case "${1:-}" in
  capture) shift; capture "$@" ;;
  build) build ;;
  *) usage ;;
esac
