"""Generate monochrome macOS template images for the Pi Studio menu bar."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
INK = (0, 0, 0, 255)
SCALE = 8


def dot(draw: ImageDraw.ImageDraw, x: float, y: float, radius: float, fill=INK) -> None:
    draw.ellipse(
        ((x - radius) * SCALE, (y - radius) * SCALE, (x + radius) * SCALE, (y + radius) * SCALE),
        fill=fill,
    )


def stroke(draw: ImageDraw.ImageDraw, points: list[tuple[float, float]], width: float) -> None:
    scaled = [(x * SCALE, y * SCALE) for x, y in points]
    pixels = max(1, round(width * SCALE))
    draw.line(scaled, fill=INK, width=pixels, joint="curve")
    radius = width / 2
    dot(draw, *points[0], radius)
    dot(draw, *points[-1], radius)


def render(size: int, running: bool) -> Image.Image:
    canvas_size = size * SCALE
    image = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    unit = size / 18

    def scaled(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
        return [(x * unit, y * unit) for x, y in points]

    # Broad top bar and two grounded legs remain readable at menu-bar scale.
    stroke(draw, scaled([(2.7, 5.1), (6.3, 4.6), (11.7, 4.6), (15.3, 5.05)]), 2.15 * unit)
    stroke(draw, scaled([(6.8, 5.7), (6.1, 8.4), (5.4, 11.6), (4.5, 14.25)]), 2.3 * unit)
    stroke(draw, scaled([(11.2, 5.7), (11.35, 8.6), (12.0, 11.8), (13.25, 14.15)]), 2.3 * unit)

    if running:
        dot(draw, 15.0 * unit, 2.55 * unit, 1.15 * unit)

    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    for suffix, size in (("", 18), ("@2x", 36)):
        render(size, False).save(ASSETS / f"trayTemplate{suffix}.png")
        render(size, True).save(ASSETS / f"trayRunningTemplate{suffix}.png")


if __name__ == "__main__":
    main()
