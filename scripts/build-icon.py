"""Export the generated Pi Studio artwork as PNG and macOS ICNS assets."""

from io import BytesIO
from pathlib import Path
import struct

from PIL import Image, ImageDraw


ASSETS = Path(__file__).resolve().parents[1] / "assets"
source = Image.open(ASSETS / "icon-source.png").convert("RGBA")

# The generated art has a few stray antialiased pixels around its tile.
# Keep the Pi and warm white field, then give the tile a clean app-icon edge.
artwork = source.crop((109, 127, 1144, 1143)).resize((940, 940), Image.Resampling.LANCZOS)
tile = Image.new("RGBA", artwork.size, (253, 251, 247, 255))
tile.alpha_composite(artwork)
mask = Image.new("L", artwork.size)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, 939, 939), radius=235, fill=255)
tile.putalpha(mask)
icon = Image.new("RGBA", (1024, 1024))
icon.alpha_composite(tile, (42, 42))
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
