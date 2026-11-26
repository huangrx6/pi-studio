"""Native exports of assets/pi-mark.svg. Requires Python 3, Pillow and CairoSVG."""

from io import BytesIO
from pathlib import Path
import struct
from xml.etree import ElementTree

import cairosvg
from PIL import Image, ImageDraw


ASSETS = Path(__file__).resolve().parents[2] / "assets"
SOURCE = ASSETS / "pi-mark.svg"


def mark_alpha(size: int) -> Image.Image:
    png = cairosvg.svg2png(url=str(SOURCE), output_width=size, output_height=size)
    return Image.open(BytesIO(png)).convert("RGBA").getchannel("A")


def app_mark(size: int) -> Image.Image:
    svg = ElementTree.parse(SOURCE).getroot()
    svg.set("fill", "#f7f7f4")
    cursor = svg.find(".//*[@id='cursor']")
    assert cursor is not None, "The Pi mark must contain a cursor"
    cursor.set("fill", "#4b8dff")
    png = cairosvg.svg2png(bytestring=ElementTree.tostring(svg), output_width=size, output_height=size)
    return Image.open(BytesIO(png)).convert("RGBA")


def write_app_icons() -> None:
    # Preserve macOS margins and the approved 25:40 mark-to-tile proportion.
    size, tile, mark = 1024, 824, 515
    scale = 2
    image = Image.new("RGBA", (size * scale, size * scale))
    margin = (size - tile) * scale // 2
    ImageDraw.Draw(image).rounded_rectangle(
        (margin, margin, size * scale - margin - 1, size * scale - margin - 1),
        radius=tile * scale // 4,
        fill="#202126",
        outline="#393b42",
        width=16 * scale,
    )
    # At 16pt, align the fine strokes to the pixel grid and give the cursor
    # enough coverage to remain visible in the Finder list at both densities.
    finder = image.resize((128, 128), Image.Resampling.LANCZOS)
    finder.alpha_composite(app_mark(75), (28, 27))
    inset = (size - mark) * scale // 2
    image.alpha_composite(app_mark(mark * scale), (inset, inset))
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
        source = finder if kind in (b"icp4", b"ic11") else icon
        source.resize((pixels, pixels), Image.Resampling.LANCZOS).save(data, format="PNG")
        chunks.append(kind + struct.pack(">I", data.tell() + 8) + data.getvalue())
    body = b"".join(chunks)
    (ASSETS / "icon.icns").write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def write_tray_icons() -> None:
    # Native template images use only alpha; macOS supplies the menu-bar ink.
    scale = 8
    size = 18 * scale
    idle = Image.new("RGBA", (size, size))
    # Leave room above the 16pt glyph for a distinct status dot at 1×.
    idle.paste("black", (scale, 2 * scale), mark_alpha(16 * scale))
    running = idle.copy()
    ImageDraw.Draw(running).ellipse(
        (14.5 * scale, 0.25 * scale, 17 * scale, 2.75 * scale), fill="black",
    )
    for name, image in (("trayTemplate", idle), ("trayRunningTemplate", running)):
        for suffix, pixels in (("", 18), ("@2x", 36)):
            image.resize((pixels, pixels), Image.Resampling.LANCZOS).save(
                ASSETS / f"{name}{suffix}.png"
            )
