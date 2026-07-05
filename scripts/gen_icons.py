"""Generate Cat HQ PWA icons: pixel-art cat, pure stdlib (zlib+struct).

Outputs to frontend/public/icons/: icon-192, icon-512, icon-maskable-512
(art shrunk into the maskable safe zone), apple-touch-icon-180.
"""
import struct
import sys
import zlib
from pathlib import Path

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

BG = (0x0F, 0x12, 0x16)
PALETTE = {
    ".": BG,
    "o": (0xF5, 0xA9, 0x7F),  # orange coat
    "p": (0xF4, 0x72, 0xB6),  # inner ears / nose
    "g": (0x34, 0xD3, 0x99),  # eyes
    "w": (0xF6, 0xF0, 0xE8),  # muzzle
}

ART = [
    "................",
    "..o..........o..",
    "..oo........oo..",
    "..opo......opo..",
    "..oooooooooooo..",
    "..oooooooooooo..",
    "..oooooooooooo..",
    "..oggooooooggo..",
    "..oggooooooggo..",
    "..oooooppooooo..",
    "..oooowwwwoooo..",
    "..oooowwwwoooo..",
    "...oooooooooo...",
    "....oooooooo....",
    "................",
    "................",
]
assert all(len(r) == 16 for r in ART) and len(ART) == 16

def png_bytes(size: int, scale: float) -> bytes:
    cell = size * scale / 16
    off = (size - cell * 16) / 2
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: None
        ay = int((y - off) / cell) if cell else -1
        row = ART[ay] if 0 <= ay < 16 else None
        for x in range(size):
            ax = int((x - off) / cell) if cell else -1
            ch = row[ax] if row is not None and 0 <= ax < 16 else "."
            raw.extend(PALETTE[ch])

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )

SPECS = {
    "icon-192.png": (192, 0.84),
    "icon-512.png": (512, 0.84),
    "icon-maskable-512.png": (512, 0.62),  # art inside the 80% safe circle
    "apple-touch-icon-180.png": (180, 0.80),
}
for name, (size, scale) in SPECS.items():
    (OUT / name).write_bytes(png_bytes(size, scale))
    print(f"wrote {name} ({size}x{size})")
