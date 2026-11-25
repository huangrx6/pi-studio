# 知识库

在「设置 → 插件 → 官方精选」安装。通过工作台的插件入口或 `/notes` 打开，选择现有的 notes 目录。应用需支持沙箱视图和全屏工作台。

## 阅读与编辑

- 左侧展示实际的文件树。用标题或正文搜索打开笔记。右键点击条目或按 Shift+F10 可以重命名、移动或移到废纸篓。顶栏路径过长时，点省略号展开完整层级。
- Markdown 支持阅读、源码和分屏，以及代码、表格、提示块、公式、Mermaid、本地图片与 Wiki 链接。拖动大纲的左边缘可调整宽度，也可以在分隔线上用方向键调整。
- 整页主题可跟随 Pi Studio，也可选择亚麻、灰绿、蓝墨或暖炭。重开时恢复主题和大纲宽度，旧的主题偏好会对应到相近的配色。[Color Hunt](https://colorhunt.co/palettes/vintage-navy) · [Radix Colors](https://www.radix-ui.com/colors/docs/palette-composition/composing-a-palette)
- HTML 可以查看源码及静态预览。预览支持内联样式，以及库内相对路径引用的图片和 CSS，脚本和外网请求被禁用。需要交互的页面可通过「用浏览器打开」交给系统浏览器。PDF 可用系统应用打开。
- 点击「保存」或按 Cmd/Ctrl+S 将修改写回文件。外部内容变动时会自动刷新，编辑中的文件保留草稿，并显示「用外部版本」「保留我的」「查看差异」。

## 目录和文件归属

选中的目录是正文和附件的唯一来源。知识库设置中的「补齐 PARA 目录和规范」会识别已存在的目录别名，创建缺少的分类和 notes-spec.md。模板沿用当前目录，未选目录时优先把新笔记放到 Inbox。分类根目录保持稳定。移动或重命名前，可从反向链接查找需要手动更新的引用。

同一应用配置下的各工作区和会话共享此库。插件数据保存在 `~/.pi-studio/data/plugin-data/studio.notes-library/studio.notes-library/`。这里存放目录配置、界面偏好和尚未保存的草稿。正文与附件由用户管理，删除会话或卸载插件仍保留所选目录里的文件。

## 在对话中使用

用 `$` 选择「知识库」，即可让 AI 列出目录、搜索和读笔记。常规会话可以根据工具权限按当前文件版本写入修改。阅读时也可以从大纲栏按「带入临时聊天」。归类与项目沉淀使用随包的 `para-notes` 技能与知识库内的规范。[默认规则](extension/notes-spec.md)

## 维护

从仓库运行 `pnpm run build:notes-ui`，重新生成 `extension/ui/`。修改包文件后，重新封存扩展并更新官方目录的包摘要。数学公式和流程图的库见 [KaTeX](https://github.com/KaTeX/KaTeX) 和 [Mermaid](https://mermaid.js.org/)。
