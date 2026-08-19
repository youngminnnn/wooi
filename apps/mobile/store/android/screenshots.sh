#!/usr/bin/env bash
#
# 스토어 스크린샷을 폰에서 받아 Play 규격으로 맞춘다.
#
#   ./screenshots.sh capture 01-workspaces   # 지금 폰 화면을 raw/01-workspaces.png 로 받는다
#   ./screenshots.sh build                   # raw/*.png → screenshots/*.png (1080×1920, 24비트)
#
# 왜 그대로 못 올리는가: Play 는 스크린샷의 **가로세로비를 최대 2:1** 로 제한한다. 요즘 폰은
# 화면이 그보다 길어서(예: 2640×1080 은 2.44:1) 기기에서 찍은 파일을 그대로 올리면 거부된다.
# 여기서는 1080×1920(9:16) 캔버스 안에 비율을 유지한 채 넣고, 남는 자리를 앱 배경색으로
# 채운다. 잘라내지 않으므로 화면 내용이 사라지지 않는다.
#
# 여백이 넓어 보이는 게 싫으면 raw/ 단계에서 상태바·내비게이션바를 먼저 잘라내거나 기기 목업
# 프레임에 얹어 두면 된다 — build 는 어떤 크기가 들어와도 규격에 맞춰 준다.
set -euo pipefail

cd "$(dirname "$0")"

CANVAS_W=1080
CANVAS_H=1920
BACKGROUND='#13161c' # src/theme 의 앱 배경과 같은 값

usage() {
  sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

capture() {
  local name="${1:-}"
  [ -n "$name" ] || usage
  command -v adb >/dev/null || { echo "adb 가 없습니다 — brew install android-platform-tools" >&2; exit 1; }
  local count
  count="$(adb devices | sed '1d' | grep -c 'device$' || true)"
  if [ "$count" -eq 0 ]; then
    echo "연결된 기기가 없습니다. 에뮬레이터를 띄우거나 USB 디버깅을 켠 폰을 물리세요." >&2
    exit 1
  fi
  # 실기기와 에뮬레이터가 함께 물려 있으면 adb 가 어느 쪽인지 묻지 않고 그냥 실패한다.
  # 스토어용은 해상도가 정확한 에뮬레이터 쪽이므로, 고르지 않은 채로는 진행하지 않는다.
  if [ "$count" -gt 1 ] && [ -z "${ANDROID_SERIAL:-}" ]; then
    echo "기기가 ${count} 대 붙어 있습니다. 어느 쪽에서 찍을지 정하세요:" >&2
    adb devices | sed '1d' | sed 's/^/  /' >&2
    echo "  export ANDROID_SERIAL=emulator-5554" >&2
    exit 1
  fi
  mkdir -p raw
  adb exec-out screencap -p >"raw/$name.png"
  printf 'raw/%s.png ' "$name"
  sips -g pixelWidth -g pixelHeight "raw/$name.png" | tail -2 | tr -d ' ' | tr '\n' ' '
  echo
}

build() {
  command -v rsvg-convert >/dev/null || { echo "rsvg-convert 가 없습니다 — brew install librsvg" >&2; exit 1; }
  shopt -s nullglob
  local files=(raw/*.png)
  if [ ${#files[@]} -eq 0 ]; then
    echo "raw/ 에 PNG 이 없습니다. 먼저 './screenshots.sh capture <이름>' 으로 받으세요." >&2
    exit 1
  fi

  mkdir -p screenshots
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  for src in "${files[@]}"; do
    local out="screenshots/$(basename "$src")"
    local w h scale dw dh dx dy
    w="$(sips -g pixelWidth "$src" | tail -1 | tr -dc 0-9)"
    h="$(sips -g pixelHeight "$src" | tail -1 | tr -dc 0-9)"
    # 비율 유지하며 캔버스 안에 넣는다(fit). 잘라내지 않는다.
    read -r dw dh dx dy < <(python3 -c "
w, h = $w, $h
s = min($CANVAS_W / w, $CANVAS_H / h)
dw, dh = w * s, h * s
print(f'{dw:.2f} {dh:.2f} {($CANVAS_W - dw) / 2:.2f} {($CANVAS_H - dh) / 2:.2f}')
")
    {
      printf '<svg width="%s" height="%s" xmlns="http://www.w3.org/2000/svg">' "$CANVAS_W" "$CANVAS_H"
      printf '<rect width="%s" height="%s" fill="%s"/>' "$CANVAS_W" "$CANVAS_H" "$BACKGROUND"
      printf '<image x="%s" y="%s" width="%s" height="%s" href="data:image/png;base64,' "$dx" "$dy" "$dw" "$dh"
      base64 -i "$src" | tr -d '\n'
      printf '"/></svg>'
    } >"$tmp/frame.svg"

    rsvg-convert -w "$CANVAS_W" -h "$CANVAS_H" "$tmp/frame.svg" -o "$tmp/frame.png"
    python3 ../shared/png-recode.py "$tmp/frame.png" "$out" rgb
    printf '  %-34s %sx%s → %sx%s\n' "$out" "$w" "$h" "$CANVAS_W" "$CANVAS_H"
  done

  echo
  echo "Play 는 폰 스크린샷을 최소 2장, 최대 8장 받습니다. 대형 화면 추천 노출까지 노리면 4장 이상."
}

case "${1:-}" in
  capture) shift; capture "$@" ;;
  build) build ;;
  *) usage ;;
esac
