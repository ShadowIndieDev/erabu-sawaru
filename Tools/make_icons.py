# SPDX-License-Identifier: GPL-3.0-or-later
"""ホーム画面のアイコン（左右2枚のカード、右を選んだ形）を作る。外部のライブラリは使わない。

使い方：python Tools/make_icons.py  →  Web/assets/icon-180.png・icon-192.png・icon-512.png
"""
import pathlib, struct, zlib

OUT = pathlib.Path(__file__).resolve().parent.parent / 'Web' / 'assets'
BG, BAND, CARD, LINE, CHOSEN, DOT = (0xf2, 0xf4, 0xee), (0x42, 0x6d, 0x68), (0xff, 0xfe, 0xfa), (0xd5, 0xde, 0xd0), (0xf2, 0xb3, 0x3d), (0x42, 0x6d, 0x68)


def inside_round(x, y, l, t, r, b, rad):
    if x < l or x >= r or y < t or y >= b:
        return False
    cx = min(max(x, l + rad), r - rad)
    cy = min(max(y, t + rad), b - rad)
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad


def pixel(u, v):
    # u, v: 0..1 の位置。4倍の細かさで平均して縁をなめらかにする。
    if v < 0.16:
        return BAND
    for left, chosen in ((0.08, False), (0.53, True)):
        l, t, r, b = left, 0.26, left + 0.39, 0.88
        if inside_round(u, v, l, t, r, b, 0.07):
            if chosen and not inside_round(u, v, l + 0.035, t + 0.035, r - 0.035, b - 0.035, 0.045):
                return CHOSEN
            if not chosen and not inside_round(u, v, l + 0.012, t + 0.012, r - 0.012, b - 0.012, 0.06):
                return LINE
            # カードの中の丸（絵の代わり）
            cx, cy = (l + r) / 2, 0.52
            if (u - cx) ** 2 + (v - cy) ** 2 <= 0.085 ** 2:
                return CHOSEN if chosen else LINE
            return CARD
    return BG


def png(size):
    rows = []
    n = 4
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0]
            for sy in range(n):
                for sx in range(n):
                    c = pixel((x + (sx + .5) / n) / size, (y + (sy + .5) / n) / size)
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
            row += bytes(round(a / (n * n)) for a in acc)
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')


if __name__ == '__main__':
    for size in (180, 192, 512):
        (OUT / f'icon-{size}.png').write_bytes(png(size))
        print(f'icon-{size}.png')
