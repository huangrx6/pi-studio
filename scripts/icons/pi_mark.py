"""Native exports of assets/pi-mark.svg. Requires Python 3, Pillow and CairoSVG."""

from io import BytesIO
from pathlib import Path
import struct

import cairosvg
from PIL import Image, ImageDraw


ASSETS = Path(__file__).resolve().parents[2] / "assets"
SOURCE = ASSETS / "pi-mark.svg"


def mark_alpha(size: int) -> Image.Image:
    png = cairosvg.svg2png(url=str(SOURCE), output_width=size, output_height=size)
    return Image.open(BytesIO(png)).convert("RGBA").getchannel("A")


def write_app_icons() -> None:
    # Keep the native icon's 100px macOS margins and its warm porcelain tile.
    size, tile, mark = 1024, 824, 704
    scale = 2
    image = Image.new("RGBA", (size * scale, size * scale))
    margin = (size - tile) * scale // 2
    ImageDraw.Draw(image).rounded_rectangle(
        (margin, margin, size * scale - margin - 1, size * scale - margin - 1),
        radius=tile * scale // 4,
        fill="#fdfbf7",
    )
    inset = (size - mark) * scale // 2
    image.paste("#252526", (inset, inset), mark_alpha(mark * scale))
    icon = image.resize((size, size), Image.Resampling.LANCZOS)
    icon.save(ASSETS / "icon.png", optimize=True)

    # Include 1× and Retina representations, preserving the 16px Finder icon.
    representations = {
        b"icp4": 16, b"icp5": 32, b"icp6": 64,
        b"ic07": 128, b"ic08": 256, b"ic09": 512, b"ic10": 1024,
        b"ic11": 32, b"ic12": 64, b"ic13": 256, b"ic14": 512,
    }
    chunks = []
    for kind, pixels in representations.items():
        data = BytesIO()
        icon.resize((pixels, pixels), Image.Resampling.LANCZOS).save(data, format="PNG")
        chunks.append(kind + struct.pack(">I", data.tell() + 8) + data.getvalue())
    body = b"".join(chunks)
    (ASSETS / "icon.icns").write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def write_tray_icons() -> None:
    # Native template images use only alpha; macOS supplies the menu-bar ink.
    scale = 8
    size = 18 * scale
    idle = Image.new("RGBA", (size, size))
    # Shift the top-heavy glyph down half a point so the running dot stays separate at 1×.
    idle.paste("black", (0, scale // 2), mark_alpha(size))
    running = idle.copy()
    ImageDraw.Draw(running).ellipse(
        (14 * scale, 0.4 * scale, 16.2 * scale, 2.6 * scale), fill="black",
    )
    for name, image in (("trayTemplate", idle), ("trayRunningTemplate", running)):
        for suffix, pixels in (("", 18), ("@2x", 36)):
            image.resize((pixels, pixels), Image.Resampling.LANCZOS).save(
                ASSETS / f"{name}{suffix}.png"
            )
