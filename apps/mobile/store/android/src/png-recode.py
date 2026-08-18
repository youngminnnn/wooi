#!/usr/bin/env python3
"""PNG 을 24비트 RGB 또는 32비트 RGBA 로 다시 쓴다.

Play 는 자산마다 채널 구성을 다르게 요구한다:

  - 앱 아이콘      512×512, **32비트 PNG(알파 포함)**
  - 피처 그래픽    1024×500, **24비트 PNG(알파 없음)** 또는 JPEG

그런데 rsvg-convert 는 그림이 전부 불투명하면 알파 채널을 떼고 24비트로 내보낸다. 즉 아이콘은
채널을 도로 붙여야 하고 피처 그래픽은 붙으면 떼야 한다 — 방향이 서로 반대라 한 도구로 둔다.

JPEG 로 바꾸면 규격은 맞지만 그라데이션과 글자에 링잉이 생긴다. 여기서는 손실 없이 채널만
바꾼다. 표준 라이브러리만 쓴다 — 자산 두 장 때문에 Pillow 를 의존성에 넣지 않는다.
"""

import struct
import sys
import zlib

BACKGROUND = (11, 14, 21)  # #0b0e15 — 투명 픽셀이 남아 있을 때 깔아 줄 색


def chunks(data: bytes):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("PNG 이 아닙니다.")
    pos = 8
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        yield kind, data[pos + 8 : pos + 8 + length]
        pos += 12 + length


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def unfilter(raw: bytes, width: int, height: int, bpp: int) -> list[bytearray]:
    stride = width * bpp
    rows: list[bytearray] = []
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        method = raw[pos]
        line = bytearray(raw[pos + 1 : pos + 1 + stride])
        pos += 1 + stride
        for i in range(stride):
            left = line[i - bpp] if i >= bpp else 0
            up = prev[i]
            upleft = prev[i - bpp] if i >= bpp else 0
            if method == 1:
                line[i] = (line[i] + left) & 0xFF
            elif method == 2:
                line[i] = (line[i] + up) & 0xFF
            elif method == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif method == 4:
                line[i] = (line[i] + paeth(left, up, upleft)) & 0xFF
            elif method != 0:
                raise SystemExit(f"알 수 없는 필터 {method}")
        rows.append(line)
        prev = line
    return rows


def write_chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def main(src: str, dst: str, mode: str) -> None:
    data = open(src, "rb").read()
    header, idat = None, bytearray()
    for kind, payload in chunks(data):
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", payload)
        elif kind == b"IDAT":
            idat += payload

    if header is None:
        raise SystemExit("IHDR 이 없습니다.")
    width, height, depth, color, _comp, _filt, interlace = header
    if depth != 8 or interlace != 0 or color not in (2, 6):
        raise SystemExit(f"지원하지 않는 PNG 입니다 (depth={depth} color={color}).")

    want = 2 if mode == "rgb" else 6
    if color == want:
        open(dst, "wb").write(data)  # 이미 원하는 모양이다
        return

    src_bpp = 3 if color == 2 else 4
    rows = unfilter(zlib.decompress(bytes(idat)), width, height, src_bpp)

    out = bytearray()
    for row in rows:
        out.append(0)  # 필터 없음 — zlib 이 알아서 줄인다
        for x in range(width):
            px = row[x * src_bpp : (x + 1) * src_bpp]
            if want == 6:
                out += bytes((px[0], px[1], px[2], 255))
            elif px[3] == 255:
                out += bytes(px[:3])
            else:
                # 언프리멀티플라이드 소스를 배경색 위에 합성한다
                out += bytes(
                    (v * px[3] + bg * (255 - px[3]) + 127) // 255
                    for v, bg in zip(px[:3], BACKGROUND)
                )

    png = bytearray(b"\x89PNG\r\n\x1a\n")
    png += write_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, want, 0, 0, 0))
    png += write_chunk(b"IDAT", zlib.compress(bytes(out), 9))
    png += write_chunk(b"IEND", b"")
    open(dst, "wb").write(bytes(png))


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[3] not in ("rgb", "rgba"):
        raise SystemExit("사용법: png-recode.py <입력.png> <출력.png> <rgb|rgba>")
    main(sys.argv[1], sys.argv[2], sys.argv[3])
