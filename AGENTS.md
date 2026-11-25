# Pi Studio 仓库开发约定

## 产品与数据边界

- Pi Studio 是基于 Pi Durable 的独立 Electron 应用。不得读取或修改旧版 `~/.pi` 目录、Pi CLI 设置及其中的 `settings.json`、`auth.json`、`models.json`。
- Studio 通过 SQLite 和 `~/.pi-studio` 下的托管目录保存自身数据；该数据根目录与 Electron 的 `userData` 分离。项目资源显式放在 `.pi-studio/`。测试和交互检查可使用 `PI_STUDIO_USER_DATA` 指定隔离目录。
- 扩展以明确受信任的 Node.js 代码在 Electron 主进程执行。完整性摘要和静态命令检查不属于操作系统级沙箱，不得据此描述隔离能力。

## 目录归属

- `electron/main/index.cjs`：应用生命周期与主进程模块组装。桌面后端在本地 Electron 中运行。
- `electron/main/core/`：应用状态、SQLite、模型、扩展契约和共享基础能力。
- `electron/main/runtime/`：Pi Durable 组合、显式内置能力注册表与运行时辅助代码。
- `electron/main/capabilities/`：按职责组织的 Agent 能力；每个能力拥有自己的清单和唯一公共入口 `index.cjs`。
- `electron/main/integrations/`：MCP、模型提供商等外部系统适配。
- `electron/main/services/`：更新、终端、窗口、发行等不拥有 Agent 能力的应用服务。
- `electron/main/ipc/`：按领域划分的主进程 IPC 处理器。
- `electron/preload/`：主窗口与菜单栏窗口的隔离桥接，不承载后端服务逻辑。
- `web/src/shell/`：应用框架、导航和公共页面容器。
- `web/src/features/`：按功能组织的组件、hooks、样式和纯函数。
- `web/src/shared/`：被多个功能使用的小型组件与前端辅助函数。
- `web/src/types/`：前端类型、渲染进程契约与 `window.piApi` 声明。
- `web/src/styles/`：全局样式入口、主题、配色与设计变量。
- `web/menubar/`：不经过 Vite 打包的菜单栏前端；HTML 放在根层，脚本与样式分别放入 `scripts/`、`styles/`。
- `website/`：产品官网与在线手册。HTML 页面保留在根层以维持公开 URL，CSS、浏览器脚本、图片分别放入 `styles/`、`scripts/`、`assets/`。
- `docs/`：仍需维护的 Markdown 文档，按架构、开发指南、扩展、维护和发布分类；入口是 `docs/README.md`。
- `sdk/cli/`：供扩展与技能作者使用的命令行入口。
- `sdk/extensions/schemas/`、`sdk/extensions/types/`：扩展协议 JSON Schema 与公共 TypeScript 声明。
- `sdk/skills/schemas/`：技能仓库协议 JSON Schema。
- `scripts/dev/`、`scripts/build/`、`scripts/icons/`、`scripts/pty/`、`scripts/release/`、`scripts/upgrades/`：内部开发、生成、打包与维护脚本。
- `scripts/qa/`：桌面和网站交互检查；输出只写入忽略提交的 `.qa/`。
- `tests/electron/`、`tests/web/`、`tests/integration/`：按执行边界组织的自动测试，文件名说明所属能力、功能或服务。
- `examples/extensions/`：扩展作者示例；`extensions/`：随应用分发的官方扩展。
- `assets/`：桌面应用图标与内置资源；精选网站截图放在 `website/assets/screens/`。
- `dist/renderer/`：生成的前端构建产物；`release/`：生成的桌面安装包。两者均忽略提交，不存放维护中的源码。

源码、测试、构建产物和截图应放入各自目录，不新增用途含混的通用文件夹。文档保留当前架构、接口契约和操作流程；过期计划、一次性审查记录与已完成任务清单不作为长期文档维护。

## 文件格式

- `web/src/` 中含 JSX 的组件使用 `.tsx`，hooks、数据与纯函数使用 `.ts`。功能、框架和共享组件的样式放在所属目录的 `styles/`；全局样式放在 `web/src/styles/`。
- Electron 主进程和预加载模块使用 `.cjs`。菜单栏页面放在 `web/menubar/`，桥接放在 `electron/preload/menu-bar.cjs`，原生窗口服务放在 `electron/main/services/menu-bar.cjs`。
- Node 测试和维护脚本使用其运行器支持的模块格式。测试直接导入前端 TypeScript 时，显式保留 `.ts` 后缀。
- Schema 的公开 `$id` 保持稳定；文件目录调整不改变协议身份。修改官方扩展文件后，更新并验证对应完整性清单。

## 实现规则

- Pi Durable 是执行事实的唯一来源。Studio SQLite 只保存自身拥有的投影、设置、资源信任和元数据。
- 内置能力通过显式静态表注册，不在运行时扫描目录；打包后的应用必须具有确定的顺序、依赖校验和可见导入。
- 能力内部实现是私有的。其他领域仅通过该能力的 `index.cjs` 或共享运行时契约依赖它。
- 不为已删除的 Pi Coding Agent 模块或旧 IPC 结构添加兼容层。仅在保护现有 Studio 数据时进行数据迁移，并对迁移进行版本管理。
- 渲染进程契约必须能安全地序列化为 JSON。Durable 句柄、任务对象、存储路径、凭据和原始扩展实现不得跨入渲染进程。
- 扩展 UI 优先使用声明式数据与设计变量；需要独立交互界面的插件通过受控沙箱视图（`pi-ext://` + `iframe sandbox` + JSON `postMessage` 桥）加载自身 `ui/` 静态资源，不直接注入主渲染进程 DOM 或访问主进程特权。
- 凭据保留在主进程并由 `safeStorage` 保护，不得记录日志、投影到扩展数据或明文发送给渲染进程。
- 全局、用户、工作区、项目和会话设置必须具有明确的作用域及优先级；不得从较窄作用域推导较宽作用域。
- 工具、技能、MCP、Harness、子智能体和扩展资源的变化，必须在下一个安全请求边界热加载。

## 验证

编辑时先运行最相关的小范围检查，完成后运行完整检查：

```sh
pnpm run extension:schema
pnpm test
pnpm run build
git diff --check
```

涉及扩展改动时，还需运行：

```sh
node sdk/cli/pi-studio-extension.mjs validate examples/extensions/agent-starter --scope user --json
```

涉及产品网站时，还需运行 `pnpm run qa:website`。GitHub Pages 直接发布 `website/`；网站本地资源应完整放在该目录内，源码文档链接指向仓库中的 `docs/`。

桌面视觉与交互检查放在 `scripts/qa/`，输出写入 `.qa/`。不提交检查产物；仅在 README 或精选文档图库确实使用时提交截图。
