# 仓库结构

Pi Studio 的后端运行在 Electron 主进程，负责本地数据、Agent 运行、系统集成与服务。桌面前端运行在渲染进程，通过预加载桥接调用有限的 IPC 接口。产品官网独立发布到 GitHub Pages。

```text
pi-studio/
├── electron/
│   ├── main/
│   │   ├── index.cjs       # 应用生命周期与模块组装
│   │   ├── core/           # SQLite、模型与共享契约
│   │   ├── runtime/        # Pi Durable 与静态能力注册
│   │   ├── capabilities/   # Agent 能力
│   │   ├── integrations/   # 模型提供商、MCP 等外部集成
│   │   ├── services/       # 终端、更新、窗口等本地服务
│   │   └── ipc/            # 主进程 IPC 处理器
│   └── preload/            # 主窗口与菜单栏的隔离桥接
├── web/
│   ├── index.html          # 桌面主窗口入口
│   ├── src/
│   │   ├── shell/          # 框架、导航与页面容器
│   │   ├── features/       # 功能 UI、hooks、纯函数及所属样式
│   │   ├── shared/         # 跨功能 UI 与前端辅助函数
│   │   ├── types/          # 前端类型与 window.piApi 声明
│   │   └── styles/         # 全局样式入口、主题与 tokens
│   └── menubar/
│       ├── index.html      # 菜单栏窗口入口
│       ├── scripts/        # 浏览器脚本
│       └── styles/         # 菜单栏样式
├── website/
│   ├── index.html          # 产品首页
│   ├── guide.html          # 在线使用手册
│   ├── styles/             # 网站 CSS
│   ├── scripts/            # 网站 JavaScript
│   └── assets/             # 官网插图与精选产品截图
├── docs/                   # Markdown：架构、指南、扩展、维护、发布
├── assets/                 # 桌面应用图标与内置资源
├── extensions/             # 随应用发布的官方扩展
├── examples/extensions/    # 扩展作者示例
├── sdk/
│   ├── cli/                # 扩展与技能开发命令行入口
│   ├── extensions/
│   │   ├── schemas/        # 扩展协议 JSON Schema
│   │   └── types/          # 扩展作者 TypeScript 声明
│   └── skills/schemas/     # 技能仓库协议 JSON Schema
├── tests/                  # electron、web、integration 边界测试
├── scripts/
│   ├── dev/                # 本地开发启动
│   ├── build/              # Schema 生成等构建准备
│   ├── qa/                 # 交互检查与测试夹具
│   ├── release/            # 打包、签名与发布
│   ├── icons/              # 图标生成与 Vite 图标插件
│   ├── pty/                # 终端原生模块准备
│   └── upgrades/           # 依赖升级检查
├── dist/renderer/          # 生成的桌面前端资源，忽略提交
└── release/                # 生成的安装包，忽略提交
```

## 文件归属

- 主进程与预加载代码使用 `.cjs`；预加载只暴露白名单桥接，不承载服务逻辑。
- 桌面前端组件使用 `.tsx`，hooks、数据与纯函数使用 `.ts`。功能样式放入所属功能的 `styles/`，全局样式集中在 `web/src/styles/`。
- 菜单栏 HTML、脚本和样式与原生窗口服务分别维护。它直接加载本地 HTML，不经过 Vite；打包配置会包含 `web/menubar/` 及其共享主题样式。
- 产品网站使用独立的 HTML、CSS、JavaScript；图片放入 `website/assets/`。首页与手册保留原有页面 URL，GitHub Pages 直接发布整个 `website/`。
- `docs/` 仅维护 Markdown。文档引用源码使用相对路径；网站引用源码文档使用 GitHub 链接。
- `sdk/` 集中维护给扩展、技能作者使用的契约和命令行入口；按 `extensions`、`skills` 区分协议，Schema 与 TypeScript 声明分目录存放。Schema 的公开 `$id` 保持稳定。
- `scripts/` 是仓库内部工具，按开发、生成、检查、发布等用途分类。生成扩展 Schema 的入口是 `scripts/build/generate-extension-schema.mjs`，产物仍落在 `sdk/extensions/schemas/`。
- 自动测试按运行边界放入 `tests/`；桌面与网站交互检查放入 `scripts/qa/`，输出留在忽略提交的 `.qa/`。

## 构建与发布

`pnpm dev` 启动 Vite 和 Electron；`pnpm run build` 检查 TypeScript，并将 `web/` 构建到 `dist/renderer/`。生产窗口从这个目录加载前端，桌面打包从 `electron/main/index.cjs` 启动应用。

Electron 打包配置显式包含主进程、预加载桥接、菜单栏页面及桌面前端产物。网站和 Markdown 文档分别由 `website/` 与 `docs/` 维护，不需要随桌面安装包分发。

仓库完整检查遵循根目录 [AGENTS.md](../../AGENTS.md#验证)。网站变更还需运行 `pnpm run qa:website`，覆盖页面资源、锚点、搜索、主题和窄屏布局。
