#!/usr/bin/env python3
"""Sanity-check generated icons by sampling pixels."""

import struct
import zlib

d = open("icons/icon128.png", "rb").read()
w, h = struct.unpack(">II", d[16:24])
pos = 8
idat = b""
while pos < len(d):
    ln = struct.unpack(">I", d[pos:pos + 4])[0]
    tag = d[pos + 4:pos + 8]
    if tag == b"IDAT":
        idat += d[pos + 8:pos + 8 + ln]
    pos += 12 + ln

raw = zlib.decompress(idat)
stride = w * 4 + 1


def px(x, y):
    o = y * stride + 1 + x * 4
    return tuple(raw[o:o + 4])


checks = {
    "corner transparent (1,1)": px(1, 1)[3] < 30,
    "shaft white (64,30)": px(64, 30)[:3] > (240, 240, 240),
    "arrow head white (64,72)": px(64, 72)[:3] > (240, 240, 240),
    "tray white (64,113)": px(64, 113)[:3] > (240, 240, 240),
    "bg opaque indigo-ish (14,64)": px(14, 64)[3] == 255 and px(14, 64)[2] > px(14, 64)[0],
    "bg cyan-ish right (113,64)": px(113, 64)[3] == 255 and px(113, 64)[2] > px(113, 64)[0],
}
failed = 0
for name, ok in checks.items():
    print(("ok  " if ok else "FAIL") + " " + name)
    if not ok:
        failed += 1
print("samples:", {k: px(*v) for k, v in {
    "corner(1,1)": (1, 1), "shaft(64,30)": (64, 30), "head(64,72)": (64, 72),
    "tray(64,113)": (64, 113), "bgL(14,64)": (14, 64), "bgR(113,64)": (113, 64)}.items()})
raise SystemExit(1 if failed else 0)
