"""Render the Pi Studio macOS icon from the vector design in assets/icon.svg.

The shapes and colors below mirror icon.svg. Pillow renders PNGs for the
standard macOS ICNS sizes.
"""

from io import BytesIO
from pathlib import Path
import struct

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SCALE = 2
SIZE = 1024 * SCALE


def scaled(value):
    return round(value * SCALE)


def interpolate(a, b, amount):
    return round(a + (b - a) * amount)


def gradient(stops):
    image = Image.new("RGBA", (SIZE, SIZE))
    draw = ImageDraw.Draw(image)
    for y in range(SIZE):
        position = y / (SIZE - 1)
        for index in range(len(stops) - 1):
            start, first = stops[index]
            end, second = stops[index + 1]
            if position <= end:
                fraction = (position - start) / (end - start)
                color = tuple(interpolate(first[i], second[i], fraction) for i in range(3))
                break
        draw.line((0, y, SIZE, y), fill=(*color, 255))
    return image


def line_mask(points, width):
    mask = Image.new("L", (SIZE, SIZE))
    draw = ImageDraw.Draw(mask)
    coords = [(scaled(x), scaled(y)) for x, y in points]
    draw.line(coords, fill=255, width=scaled(width), joint="curve")
    radius = scaled(width) / 2
    for x, y in (coords[0], coords[-1]):
        draw.ellipse((round(x - radius), round(y - radius), round(x + radius), round(y + radius)), fill=255)
    return mask


canvas = Image.new("RGBA", (SIZE, SIZE))
tile_mask = Image.new("L", (SIZE, SIZE))
ImageDraw.Draw(tile_mask).rounded_rectangle(
    (scaled(44), scaled(44), scaled(980), scaled(980)),
    radius=scaled(216), fill=255,
)
canvas.paste(gradient([
    (0, (32, 43, 69)), (.5, (18, 26, 44)), (1, (11, 16, 28)),
]), (0, 0), tile_mask)
ImageDraw.Draw(canvas).rounded_rectangle(
    (scaled(45), scaled(45), scaled(979), scaled(979)),
    radius=scaled(215), outline=(255, 255, 255, 32), width=scaled(2),
)

leg_color = gradient([(0, (255, 255, 255)), (1, (223, 233, 255))])
for points in [
    [(404, 399), (374, 667)],
    [(636, 399), (612, 635), (612, 652), (618, 665), (630, 676), (645, 681), (658, 681)],
]:
    canvas.paste(leg_color, (0, 0), line_mask(points, 91))

bar_color = gradient([(0, (128, 182, 255)), (1, (75, 127, 244))])
canvas.paste(bar_color, (0, 0), line_mask([(277, 375), (747, 375)], 84))

icon = canvas.resize((1024, 1024), Image.Resampling.LANCZOS)
icon.save(ASSETS / "icon.png")

chunks = []
for size, kind in ((16, b"icp4"), (32, b"icp5"), (64, b"icp6"),
                   (128, b"ic07"), (256, b"ic08"), (512, b"ic09"),
                   (1024, b"ic10")):
    output = BytesIO()
    icon.resize((size, size), Image.Resampling.LANCZOS).save(output, format="PNG")
    data = output.getvalue()
    chunks.append(kind + struct.pack(">I", len(data) + 8) + data)
body = b"".join(chunks)
(ASSETS / "icon.icns").write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)

print(ASSETS / "icon.icns")
