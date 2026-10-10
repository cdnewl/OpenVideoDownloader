#!/usr/bin/env python3
"""Generate extension icons (16/32/48/128 px PNG) using only the stdlib.

Design: rounded square with an indigo->cyan diagonal gradient and a white
download arrow over a base tray, drawn with 8x supersampling.
"""

import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "icons"))

C1 = (99, 102, 241)   # indigo
C2 = (34, 211, 238)   # cyan
SS = 8                # supersampling factor


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def write_png(path, w, h, rows):
    raw = b"".join(b"\x00" + b"".join(bytes(px) for px in row) for row in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    payload = b"\x89PNG\r\n\x1a\n"
    payload += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    payload += chunk(b"IDAT", zlib.compress(raw, 9))
    payload += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(payload)


def render(size):
    W = size * SS
    r = 0.24 * W

    # Geometry (fractions of W)
    shaft_x0, shaft_x1 = 0.38 * W, 0.62 * W
    shaft_y0, shaft_y1 = 0.22 * W, 0.55 * W
    head_y0, head_y1 = 0.52 * W, 0.79 * W
    head_w = 0.60 * W  # full width at the top of the triangle
    tray_x0, tray_x1 = 0.24 * W, 0.76 * W
    tray_y0, tray_y1 = 0.86 * W, 0.92 * W

    def inside_rounded(x, y):
        corners = (
            (r, r),
            (W - r, r),
            (r, W - r),
            (W - r, W - r),
        )
        for cx, cy in corners:
            dx, dy = x - cx, y - cy
            in_x = cx < W / 2 and x < cx or cx > W / 2 and x > cx
            in_y = cy < W / 2 and y < cy or cy > W / 2 and y > cy
            if in_x and in_y and dx * dx + dy * dy > r * r:
                return False
        return True

    def inside_arrow(x, y):
        if shaft_x0 <= x <= shaft_x1 and shaft_y0 <= y <= shaft_y1:
            return True
        if head_y0 <= y <= head_y1:
            frac = (head_y1 - y) / (head_y1 - head_y0)
            half = head_w / 2 * frac
            if abs(x - W / 2) <= half:
                return True
        return False

    def inside_tray(x, y):
        return tray_x0 <= x <= tray_x1 and tray_y0 <= y <= tray_y1

    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            bg_cov = 0
            fg_cov = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px * SS + sx + 0.5
                    y = py * SS + sy + 0.5
                    if inside_rounded(x, y):
                        bg_cov += 1
                        if inside_arrow(x, y) or inside_tray(x, y):
                            fg_cov += 1
            n = SS * SS
            if bg_cov == 0:
                row.append((0, 0, 0, 0))
                continue
            t = (px + py) / (2 * (size - 1)) if size > 1 else 0
            base = lerp(C1, C2, t)
            cov = fg_cov / n
            color = tuple(round(base[i] + (255 - base[i]) * cov) for i in range(3))
            row.append((color[0], color[1], color[2], round(255 * bg_cov / n)))
        rows.append(row)
    return rows


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, size, size, render(size))
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
