"""从生成的艺术图导出 Pi Studio 的 PNG 与 macOS ICNS 图标。

用途
----
assets/icon-source.png 是设计稿（四周带少量抗锯齿杂边）。本脚本负责：
1. 裁掉多余边缘，缩放到 940×940 的内容瓦片；
2. 给瓦片加暖白底与圆角蒙版，居中放进 1024×1024 透明画布；
3. 输出 assets/icon.png；
4. 按 macOS ICNS 的 chunk 结构打包 assets/icon.icns。

运行
----
    python3 tools/icons/build-icon.py

依赖
----
- Python 3.9+
- Pillow：`python3 -m pip install pillow`
- 标准库：io、pathlib、struct

注意
----
脚本按仓库根目录的 assets/ 读写，输出会覆盖 assets/icon.png 与
assets/icon.icns；重新生成后需要重新执行 `pnpm run dist` 才会进入安装包。
"""

from io import BytesIO
from pathlib import Path
import struct

from PIL import Image, ImageDraw


ASSETS = Path(__file__).resolve().parents[1] / "assets"

# 最终图标规格：1024×1024 画布，内容瓦片 940×940，四周各留 42px。
ICON_SIZE = 1024
TILE_SIZE = 940
TILE_MARGIN = (ICON_SIZE - TILE_SIZE) // 2
# 圆角半径约为瓦片边长的 1/4，接近 macOS Big Sur 之后的图标轮廓。
CORNER_RADIUS = 235
# 暖白底色，衬托艺术图里透明/半透明的区域。
BACKGROUND = (253, 251, 247, 255)
# 设计稿中有效内容的裁剪框：(左, 上, 右, 下)，去掉四周杂散像素。
SOURCE_CROP = (109, 127, 1144, 1143)

# ICNS chunk 类型码与像素尺寸的对应关系。
# icp4/icp5/icp6 是 16/32/64px，ic07~ic10 是 128/256/512/1024px。
ICNS_CHUNKS = (
    (16, b"icp4"),
    (32, b"icp5"),
    (64, b"icp6"),
    (128, b"ic07"),
    (256, b"ic08"),
    (512, b"ic09"),
    (1024, b"ic10"),
)

source = Image.open(ASSETS / "icon-source.png").convert("RGBA")

# 1. 裁剪 + 缩放；LANCZOS 重采样让缩小后的边缘保持平滑。
artwork = source.crop(SOURCE_CROP).resize((TILE_SIZE, TILE_SIZE), Image.Resampling.LANCZOS)
# 2. 先铺暖白底，再叠加艺术图：艺术图自身的透明区域会露出底色。
tile = Image.new("RGBA", artwork.size, BACKGROUND)
tile.alpha_composite(artwork)
# 3. 用灰度蒙版裁出圆角：fill=255 表示保留，圆角外为 0（透明），
#    再把蒙版作为 alpha 通道写回瓦片。
mask = Image.new("L", artwork.size)
ImageDraw.Draw(mask).rounded_rectangle(
    (0, 0, TILE_SIZE - 1, TILE_SIZE - 1), radius=CORNER_RADIUS, fill=255
)
tile.putalpha(mask)
# 4. 居中放入 1024×1024 透明画布，得到最终 PNG。
icon = Image.new("RGBA", (ICON_SIZE, ICON_SIZE))
icon.alpha_composite(tile, (TILE_MARGIN, TILE_MARGIN))
icon.save(ASSETS / "icon.png")

# 5. 生成 ICNS：每个 entry 为 [4 字节类型][4 字节大端长度][PNG 数据]，
#    长度字段包含类型与长度自身，因此是 len(data) + 8；文件头结构相同。
chunks = []
for size, kind in ICNS_CHUNKS:
    output = BytesIO()
    icon.resize((size, size), Image.Resampling.LANCZOS).save(output, format="PNG")
    data = output.getvalue()
    chunks.append(kind + struct.pack(">I", len(data) + 8) + data)
body = b"".join(chunks)
(ASSETS / "icon.icns").write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)

# 打印产物路径，方便在终端或 CI 日志中确认生成成功。
print(ASSETS / "icon.icns")
