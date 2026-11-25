# Excalidraw for Pi Studio

聊天开始绘图时，Excalidraw 自动打开当前会话的侧栏。画笔依次勾勒节点、沿路径画出连线，并逐字写入标题与标签。绘制完成后，可以手动编辑和导出 `.excalidraw` 文件。

需要 Pi Studio **0.0.14 或更新版本**。从聊天自动排版需要本机 **Python 3.10+**。画布编辑器、逐笔动画与场景校验完全打包在插件自身的 `extension/ui/` 与 `extension/scene.mjs` 中，通过 Studio 的通用沙箱视图协议 `panel.view`（`pi-ext://`）加载，不与主应用前端耦合。

## 安装

- **插件市场**。在「设置 → 插件 → 浏览市场」进入「官方精选」，安装 **Excalidraw**。
- **本地安装**。在「设置 → 插件 → 本地安装」选择含 `pi-studio.plugin.json` 的插件目录，或选择 `.pi-plugin.zip` 包。

安装后打开一段聊天，从启动台的「插件」组选择 **Excalidraw**，也可以在输入框执行 `/excalidraw`。

## 使用

- **聊天绘图**。输入 `$`，在「插件」中选中 **Excalidraw**，再发送「在侧栏画一张横向架构图，客户端请求 API，API 读取数据库」。工具开始排版时会打开画布。启用系统减少动态效果时，画布直接显示完整图形。
- **继续绘图**。发送「在这张图里加一个缓存节点，连到 API」。插件会读取已有图形，并在当前聊天的画布上添加新内容。
- **接着手改**。绘制完成后，可在画布上调整形状、文字和连线。使用工具栏的「导出 Excalidraw 文件」保存可编辑副本。

画布支持架构图、依赖图、流程图、状态图、拓扑图和思维导图。每段聊天的图形独立保存在本机，重启后打开对应聊天即可继续编辑。画布数据由 Studio 单独管理，安装包只分发代码、技能和资源。

## 导入与技能

| 来源 | 打开方式 |
| --- | --- |
| `.excalidraw` | 在画布工具栏选择「导入 Excalidraw 文件」。替换已有内容前会显示确认。 |
| Mermaid | 在工具栏选择「从 Mermaid 导入」，粘贴支持的 Mermaid 图形并插入到画布。 |
| `.drawio` | 在 Draw.io 中编辑。需要在侧栏继续时，可用同一份规格生成 `.excalidraw` 版。 |

随包的 [`diagram-authoring`](extension/skills/diagram-authoring/SKILL.md) 与上游 `agent-skills` 仓库同名同源，包含完整脚本、参考文档、示例与跨后端 `.excalidrawlib` 图标支持（含 `style.edges` 圆角/曲线/直连、无框 `shape: "icon"` 与平行边错开）。聊天工具直接调用包内的 `emit_excalidraw.py`，因此和命令行生成共用规格、配色、图标、排版和校验。包内保留 Draw.io 和 Mermaid 后端，文件交付也可使用这份技能；后续直接替换该目录即可完成同步。

聊天绘图走 Studio 本地工具和事件接口，安装后可直接使用。官方编辑器在 Studio 内运行，绘图无需连接 Excalidraw MCP 或 Excalidraw 网站。

## 包结构

```text
excalidraw/
├── pi-studio.plugin.json
├── README.md
├── LICENSE
├── assets/
│   ├── icon.png
│   └── EXCALIDRAW-LICENSE
├── extension/
│   ├── pi-studio.extension.json
│   ├── extension.mjs
│   ├── scene.mjs
│   ├── diagram-authoring.mjs
│   ├── diagram.mjs
│   ├── integrity.json
│   ├── ui/                    # 独立构建的前端静态产物与 Excalidraw 字体资源
│   └── skills/diagram-authoring/
│       ├── SKILL.md
│       ├── scripts/
│       ├── references/
│       └── examples/
```

`extension.mjs` 提供 `excalidraw_draw`、`excalidraw_read` 和 `scene` 数据源（支持 `invoke('save', ...)`）。`scene.mjs` 负责画布结构校验；`diagram-authoring.mjs` 调用随包的技能排版引擎；`diagram.mjs` 处理连接到现有对象的节点与连线。整个目录可以复制出来单独安装。

## 校验与打包

在 Pi Studio 仓库根目录运行：

```sh
node scripts/build/build-excalidraw-plugin-ui.mjs
plugin_dir="$PWD/assets/official-plugins/packages/excalidraw"
node sdk/cli/pi-studio-extension.mjs seal "$plugin_dir/extension" --scope user
node sdk/cli/pi-studio-plugin.mjs validate "$plugin_dir" --json
node sdk/cli/pi-studio-extension.mjs validate "$plugin_dir/extension" --scope user --json

archive="$PWD/release/studio.excalidraw-2.0.0.pi-plugin.zip"
mkdir -p "$PWD/release"
(
  cd "$plugin_dir"
  zip -q -X -r "$archive" pi-studio.plugin.json README.md LICENSE assets extension -x '*/.*' '*/__pycache__/*'
)
```

归档根目录应直接包含 `pi-studio.plugin.json`。更新扩展文件后，先用 `pi-studio-extension seal` 重新生成 `extension/integrity.json`。发布新插件版本时更新插件清单和官方目录中的版本，并将插件校验输出的 `contentHash` 填入官方目录对应版本的 `sha256`。

## 许可

插件代码和随包技能均使用 MIT 许可。包内图标来自 Excalidraw。分别见 [插件许可](LICENSE)、[技能许可](extension/skills/diagram-authoring/LICENSE) 和 [Excalidraw 许可](assets/EXCALIDRAW-LICENSE)。
