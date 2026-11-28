# 插件、原语与界面落点

## Excalidraw 画布

从「设置 → 插件」安装 **Excalidraw**。安装后可在启动台的「插件」组或通过输入框的 `/excalidraw` 打开画布。在聊天里开始绘图时，插件会自动打开对应的画布，画笔依次勾勒节点、写出文字、画出连线。绘制完成后可以在 Excalidraw 官方编辑器中继续手动编辑，或导出为 `.excalidraw` 文件。画布按聊天保存在本机。

在聊天输入框输入 `$`，切到「插件」并选中 **Excalidraw**，再输入绘图需求。插件引用随消息发送。Studio 会在发送时根据当前启用的资源提供对应工具和技能，工具调用沿用聊天的权限设置。

画布显示「已保存到当前聊天」后，重新打开同一聊天即可继续编辑。默认保存目录是 `~/.pi-studio/data/plugin-data/studio.excalidraw/studio.excalidraw/sessions/`，文件名为 `<内部会话 ID>.excalidraw.json`（兼容读取旧版根目录文件）。Agent 可以通过 `excalidraw_read` 读取当前会话的画布。画布菜单中的「清除画布」会保存空白场景。要另存独立文件，点击画布工具栏的「导出 Excalidraw 文件」。

归档会话保留画布。永久删除会话会按扩展数据目录下的 `sessions/<conversationId>.*` 通用约定清理会话文件与嵌入图片。前端编辑器、播放动画与场景校验已完全打包在插件自身的 `extension/ui/` 内，卸载后主应用零残留。导出的文件由用户管理。

| 用途 | 入口 |
| --- | --- |
| 工具面板中实时绘图 | 插件的 `diagram-authoring` 技能和 Studio 绘图工具 |
| 按规格制图、校验布局和交付源文件 | 同一份随包 `diagram-authoring` 技能，支持 Excalidraw、Draw.io 与 Mermaid |
| 从 Mermaid 文本开始 | 画布工具栏的「从 Mermaid 导入」，转换为可编辑的 Excalidraw 元素 |
| 编辑 Draw.io 原生文件 | 使用 Draw.io。如果需要在工具面板继续编辑同一张技术图，可用同一规格重新生成 Excalidraw 版本 |

工具面板可绘制架构图、依赖图、流程图、状态图、拓扑图和思维导图。聊天绘图由 Studio 的本地工具调用包内的 Python 排版脚本，无需全局技能或 Excalidraw MCP。

完整安装包位于[官方插件源](../../assets/official-plugins/README.md)。本地安装、兼容要求和打包步骤见 [Excalidraw 插件 README](../../assets/official-plugins/packages/excalidraw/README.md)。

## 全局任务看板

从「设置 → 插件 → 官方精选」安装任务看板。从悬浮工具面板或通过 `/taskboard` 打开。看板、归档视图与编辑弹窗均运行在插件自身的 `extension/ui/` 沙箱视图内，支持：

- **任务分类与多项目关联**：支持需求、Bug、优化、常规任务四种类型（新建仅填标题即可保存，默认常规任务）；支持单/多项目关联，便于跟踪跨项目对接任务。
- **自动时间与进展记录**：拖入「进行中」自动记录实际开始时间，拖入「已完成」自动记录实际完成时间；详情弹窗内保留状态流转与随手记进展的时间线。
- **归档与恢复**：已完成卡片先留在看板方便核对，支持单张归档或列标题「批量归档已完成」；「归档」页支持按标题、类型、关联项目和完成日期检索，并支持「恢复到看板」或「重新打开」。
- **临时会话 AI 梳理日报/周报**：各会话和工作区共享同一份 `~/.pi-studio/data/plugin-data/studio.task-board/studio.task-board/tasks.sqlite`。插件提供只读工具 `task_board_list`、`task_board_get`、`task_board_summary` 以及 `task-board-reporting` 技能，在临时会话或任意会话中均可按指定周期与项目梳理日报或周报，不污染其他会话上下文。[任务看板使用说明](../../assets/official-plugins/packages/task-board/README.md)

## 全局知识库

在「设置 → 插件 → 官方精选」安装「知识库」。从插件目录或通过 `/notes` 打开。首次选择已有的 notes 目录即可阅读、编辑和搜索。左侧是目录与搜索。主题应用于整个知识库，右侧大纲可以拖动调整宽度。已有目录可以同时作为普通工作区访问。

文件和附件保存在所选目录。插件配置与待保存的草稿单独写在 `studio.notes-library` 的插件数据目录。补齐 PARA 目录和规范需要在面板内主动执行，沿用已有分类名。临时聊天可读取笔记，常规会话也可按工具权限写入。[使用说明](../../assets/official-plugins/packages/notes-library/README.md)

## 插件与基础资源

安装包和插件运行数据各有一个公共根目录，按插件 ID 分目录。

```text
~/.pi-studio/
├── plugins/<plugin-id>/<version>/                  # 安装包
├── plugins/<plugin-id>/skills/                     # 插件托管的技能
└── data/plugin-data/<plugin-id>/<manifest-id>/     # 插件内扩展的运行数据
```

扩展从 `activate(context)` 获取 `context.dataDirectory`。升级和重装使用同一个数据目录，停用和卸载时保留已有数据。安装包里的代码按版本管理。插件若按会话存盘，可把会话文件放在 `<dataDirectory>/sessions/<conversationId>.*`，永久删除会话时 Studio 会按这一通用约定自动清理，无需在宿主硬编码任何插件 ID。独立安装的扩展使用[扩展目录约定](../extensions/README.md)。

本文是 Pi Studio **可安装能力** 与 **界面落点** 的约定入口。它回答四件事：

1. 插件（Plugin）与 MCP / Skill / Extension 各自是什么、如何组合；
2. 用户从哪里发现、安装、启停、卸载这些能力；
3. 扩展 UI 的工具视图、摘要和详情如何展示；
4. 哪些产品能力已退出范围（模型双跑、视频分镜）。

运行时细节仍以既有文档为准，本文不重复协议字段表：

| 主题 | 权威文档 |
| --- | --- |
| 作用域、存储、冲突、刷新 | [资源作用域](./resources.md) |
| Extension 清单、权限、Agent 入口 | [扩展规范](../extensions/README.md) |
| 声明式 UI block 与校验 | [Extension UI](../extensions/ui.md) |
| 打包、签名、registry、安装事务 | [扩展发行](../extensions/distribution.md) |
| Skill 源与目录 | [Skill Hub](./skill-hub.md) |

---

## 1. 设计目标

- **用户买的是一整包能力**，不是互不相关的配置项。一次安装可得到 MCP、技能、**CLI** 与（可选）工具面板界面的任意组合。
- **原语协议保持独立**。不把 MCP、Skill、Extension 合并成一种新的执行格式；插件只负责包装、发现、归属与生命周期。
- **官方只精选一部分**；长尾靠目录源与用户自定义安装，不逐个平台硬编码接入。
- **摘要显示在一个位置**。用户可以选择状态栏、已声明的输入框位置，或隐藏摘要。
- **高级路径仍在**：用户仍可单独添加 MCP、单独安装 Skill、单独安装 Extension。

---

## 2. 三层模型

```text
目录 Catalog（官方 / 社区 / 个人源）
        │ 发现与版本
        ▼
插件 Plugin（产品包装：id、图标、简介、provides）
        │ 安装 / 启停 / 卸载
        ┌──────────┬──────────┬──────────┬──────────┐
        ▼          ▼          ▼          ▼          ▼
     MCP 连接   Skill 包  Extension    CLI      其他资源
   外部工具协议  流程与提示 工具+声明式UI 可调用命令  静态/配置
```

| 层 | 稳定身份 | 职责 | 用户心智 |
| --- | --- | --- | --- |
| **原语 Primitive** | MCP `name`、Skill `name`、Extension `manifest.id` | 执行、权限、热加载、数据存储 | 「这个服务器 / 这个技能 / 这个扩展」 |
| **插件 Plugin** | `plugin.id`（全局唯一，建议反向域名或短 slug） | 打包多原语、市场卡片、一次安装、归属、整体启停 | 「Excalidraw 这个插件」 |
| **目录 Catalog** | registry URL 或内置官方源 | 浏览、搜索、分类、更新检查 | 「公开 / 社区 / 我的源」 |

### 2.1 什么时候用插件，什么时候用原语

| 场景 | 推荐 |
| --- | --- |
| 一个产品同时需要 MCP + Skill，或 MCP + 工具面板 UI | **插件包** |
| 只要连一台已有 MCP 服务器 | 设置里 **手动添加 MCP** |
| 只要一条可复用流程提示 | **Skill Hub** 或项目 skills 目录 |
| 只要 Studio 内工具或声明式面板，且作者只发 Extension | 继续用 **Extension** 安装；也可日后被某插件 `provides.extension` 引用 |
| 产品以命令行工具为主（本地 bin、官方 CLI） | **插件包 + `provides.cli`**；由 Agent 经终端/受控 shell 调用，或由 Skill 写明用法 |
| 官方内置能力（core / optional） | 仍走 builtin Extension，不强制改造成插件市场条目 |

### 2.2 插件不拥有的东西

- 不替代 Durable 会话、权限策略、模型凭据。
- 不执行 `postinstall`、不跑任意 shell 安装脚本（与扩展发行一致：先隔离再校验）。
- 不把未受控代码直接注入主渲染进程 DOM（独立交互界面必须通过 `panel.view` 声明并由 `pi-ext://` + `iframe sandbox` 隔离渲染，普通声明式面板走 JSON）。
- 不把全网 MCP 目录镜像进官方源。

---

## 3. 插件包约定

### 3.1 清单（逻辑形状）

插件在磁盘上是一个目录或 zip，根清单建议 `pi-studio.plugin.json`（实现阶段可与 extension manifest 合并演进，但**产品语义**必须能表达下面字段）：

```json
{
  "format": 1,
  "kind": "plugin",
  "id": "excalidraw",
  "name": "Excalidraw",
  "version": "0.3.4",
  "publisher": "example",
  "description": "让 Agent 生成图形，在工具面板编辑并导出。",
  "icon": "assets/icon.png",
  "category": "productivity",
  "homepage": "https://example.com/excalidraw",
  "provides": {
    "mcp": [
      {
        "name": "excalidraw",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-everything"],
        "envKeys": []
      }
    ],
    "skills": [
      { "path": "skills/excalidraw" }
    ],
    "extension": { "path": "extension" },
    "cli": [
      {
        "id": "gh",
        "name": "GitHub CLI",
        "bin": "bin/gh",
        "version": "2.x",
        "description": "在终端中调用 gh，完成 PR 与 Issue 操作。",
        "pathEnv": true,
        "commands": [
          { "summary": "查看 PR", "example": "gh pr list" },
          { "summary": "创建 Issue", "example": "gh issue create" }
        ]
      }
    ]
  }
}
```

规则：

- `id` + `version` 不可变；同版本内容变更必须升版本（与扩展发行一致）。
- `provides` 至少一项；允许只含 MCP、只含 Skill、只含 Extension、**只含 CLI**，或任意组合。
- `provides.mcp[]` 写入应用级 `mcp_servers`，并带归属字段（见 §4）。
- `provides.skills[]` 走现有 Skill 安装/校验路径，安装到用户或插件受管目录。
- `provides.extension` 指向符合 `pi-studio.extension.json` 的子树；权限、签名、UI 校验沿用扩展发行。
- 插件清单的 `icon` 指向包内 PNG（最长边 512 px，最大 64 KiB）。目录条目可以用同样的包内路径。图标会出现在插件列表、启动台和该插件贡献的标签页。启动台的系统工具、插件和独立扩展分组展示，组内顺序自动保存。
- `provides.cli[]` 登记可调用的命令行能力（见 §3.3）；**不是**第四种 Agent 工具协议，也不替代 MCP。
- 其他静态资源（样例、模板、词典）可作为包内文件被 Skill/Extension 引用，不必单独 `provides` 类型。

### 3.2 与「纯 Extension」的关系

| 形态 | 说明 |
| --- | --- |
| **Extension-only** | 今天的 `.pi-extension.zip` / 目录安装，继续支持；设置「扩展」列表可见。 |
| **Plugin bundle** | 市场主推形态；详情页展示「本包提供：MCP / 技能 / 界面」。 |
| **Extension 被插件引用** | 插件安装时激活对应 extension；卸载插件时按归属回收。 |

短期实现可「插件 = 带 `provides` 元数据的 extension 发行物 + 安装器副作用」。长期仍建议独立 `kind: plugin`，避免把市场卡片语义塞进所有 Agent 扩展。

---

### 3.3 CLI 提供项（`provides.cli`）

许多生态只提供 **CLI**（如 `gh`、`docker`、厂商官方命令行），没有 MCP server，也不需要 Studio 工具视图。插件必须能包装这类能力，否则市场只能覆盖「有 MCP 的那一半」。

#### 语义

| 点 | 约定 |
| --- | --- |
| **是什么** | 插件安装后，在本机提供一个（或一组）可执行命令，供用户终端与 Agent 经**已有 shell/终端工具**调用 |
| **不是什么** | 不是新的 `cli__*` 工具命名空间；不把任意 argv 提升为与 MCP 平级的 JSON-RPC 协议 |
| **与 MCP 关系** | 同一产品可同时 `provides.mcp` + `provides.cli`（例如 CLI 给人用，MCP 给模型结构化用）；也可 **仅 CLI** |
| **与 Skill 关系** | 推荐用 Skill 写清「何时调用、常用子命令、危险操作」；Skill 可引用 `cli.id` |
| **与 Extension 关系** | 可选：声明式面板展示 CLI 状态或「在终端运行」动作；不强制 |

#### 清单字段（逻辑）

```json
{
  "id": "gh",
  "name": "GitHub CLI",
  "bin": "bin/gh",
  "description": "…",
  "pathEnv": true,
  "platform": ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"],
  "commands": [
    { "summary": "列出 PR", "example": "gh pr list" }
  ],
  "envKeys": ["GH_TOKEN"],
  "optional": false
}
```

| 字段 | 含义 |
| --- | --- |
| `id` | 插件内唯一；归属与启停键 |
| `bin` | 包内相对路径，或 `command` 形式的「调用系统已安装二进制」（见下） |
| `pathEnv` | `true` 时安装后把该 bin 目录加入 Studio 终端/Agent shell 的 `PATH` 前缀（仅 Studio 会话环境，不改用户全局 shell rc） |
| `platform` | 可选；按当前 OS/arch 选择资产，缺省表示通用脚本 |
| `commands` | 详情页与 Skill 可引用的示例，**不**自动注册为独立 Agent 工具 |
| `envKeys` | 仅声明需要的环境变量名；值仍走用户配置 / safeStorage，不进明文清单 |
| `optional` | `true` 时缺省平台或用户跳过下载不导致整包安装失败 |

**两种交付形态：**

1. **包内二进制 / 脚本**：`bin` 指向插件包内文件；安装校验 integrity；执行前受工作区与权限策略约束。
2. **系统已有 CLI**：`bin` 或 `command` 指向 `gh`、`docker` 等；安装时做 `which`/版本探测，详情页显示「未安装 / 已找到 v…」；插件负责引导安装文档，不默默下载未知脚本。

#### 运行与安全

- Agent 调用 CLI = 走现有 **终端 / shell 类工具** 与权限策略（`ask` / 工作区边界），不新增绕过通道。
- 包内二进制与扩展一样：先 quarantine、完整性、可选签名；**禁止**安装阶段对网络任意 `curl | sh`。
- `pathEnv` 只影响 Studio 拉起的终端与 Agent shell 环境块，卸载/停用插件时移除前缀。
- 需要密钥的 CLI：只声明 `envKeys`，在设置「插件 → 该插件」或 MCP 同类凭据 UI 中由用户填写，经 `safeStorage` 注入运行环境。

#### 详情与设置中的展示

- 插件详情「本包提供」增加 **命令行** 分组：名称、示例命令、检测状态。
- 设置 → 插件 → 某插件：可查看 PATH 是否注入、探测版本、打开终端文档。
- MCP Tab **不**把 CLI 列成 server；避免用户以为 CLI 是 MCP。

#### 何时优先 MCP，何时只给 CLI

| 情况 | 建议 |
| --- | --- |
| 有稳定 MCP，模型需要结构化 tool result | **MCP 为主**，CLI 可选给人用 |
| 官方只有 CLI，社区暂无 MCP | **仅 `provides.cli` + Skill** 说明用法 |
| CLI 极其危险（销毁资源、改生产） | Skill 标明；默认权限偏 `ask`；详情页警告 |
| 同一操作既有 CLI 又有 MCP | 不要注册两套等价 Agent 工具；模型走 MCP，CLI 给人与排障 |

## 4. 归属、启停与冲突

### 4.1 归属字段

凡由插件安装器创建的原语，必须可追溯：

```text
ownerPluginId   插件 id
origin          plugin | user | builtin
managed         true 时随插件启停/卸载
userOverride    用户改过托管 MCP/Skill 配置时为 true
```

- `origin: user`：设置里手动添加的 MCP、Skill Hub 单独安装、非插件路径的 extension。
- `origin: plugin` 且 `managed: true`：默认随插件生命周期。
- `userOverride: true`：卸载插件时**询问**保留或删除，不得静默丢掉用户改动。

### 4.2 生命周期

| 操作 | 行为 |
| --- | --- |
| 安装 | quarantine → 校验 → 预览将创建的 MCP/Skill/Extension 与权限 → 用户确认 → **同一事务**写入插件登记与子原语 |
| 启用 | 托管 MCP 允许连接；托管 Skill 进入发现；托管 Extension 进入 host；托管 CLI 注入 PATH（若 `pathEnv`） |
| 停用 | 托管资源整体对 Agent/UI 不可见；移除 CLI PATH 前缀；不断开用户未归属的资源 |
| 升级 | 同 id 新版本；权限只增不减时可沿用同意，**新增权限必须再确认**（同扩展发行） |
| 卸载 | 删除插件登记；删除仍 `managed && !userOverride` 的子原语（含 CLI 登记与 PATH）；有 override 则提示 |

### 4.3 冲突

| 冲突 | 策略 |
| --- | --- |
| 插件 id 已安装 | 走升级，不并行装两份同 id |
| MCP `name` 已被 `origin:user` 占用 | 安装预览失败或提供「改用后缀名 / 取消」，**默认不覆盖**用户手建 |
| MCP `name` 已被另一插件占用 | 拒绝或要求先卸旧插件 |
| Skill 同名 | 沿用 [资源作用域](./resources.md) 的发现顺序；托管技能升级时替换同 owner 旧版 |
| Extension manifest id | 沿用扩展 runtime 的 user/project/builtin 规则；`core`/`optional` 不可被普通插件替换 |

### 4.4 列表中的呈现

- **MCP 设置**：先「用户添加」，再 **按 `ownerPluginId` 分组**（组头用插件图标与名称）。
- **技能设置**：已装技能可显示「来自插件 · Excalidraw」；插件停用时灰显或折叠。
- **扩展设置**：区分「插件附带」与「独立扩展」；附带项的卸载入口指向插件，避免拆包残缺。

---

## 5. 目录源与自定义

与 Skill Hub 对齐，插件发现使用**可插拔源**，而不是写死平台列表。

| 源 | 默认 | 内容 |
| --- | --- | --- |
| 官方 Official | 开启 | 精选、签名、分类与图标规范齐全的插件 |
| 社区 Community | 可选 | 公开 static registry JSON |
| 个人 / 团队 | 用户添加 | 自有 registry URL、GitHub org、本地目录 |
| 直接安装 | 始终可用 | 本地目录、`.pi-plugin.zip` / 现有 extension 包、HTTPS、`github:owner/repo@ref`、`registry:id@version` |

用户自定义插件作者路径：

1. 本地目录开发（`provides` 指向同仓 mcp 配置草稿、skill、extension）；
2. 校验与打包（复用 extension CLI 的隔离、integrity、可选签名）；
3. 发布到自有 registry 或 GitHub Release；
4. 在 Studio「添加源」或「从 URL / 本地安装」。

官方源**只维护精选**；全网 MCP/Skill/CLI 组合靠源与社区增长。

实现（D4）：

- 官方目录：`assets/official-plugins/registry.json`（打包进 `official-plugins`）；
- 用户源：设置 → 插件 → 市场 → 管理源（HTTPS registry 或本地目录）；
- 安装：市场卡片 → 预览 → 复用 D3 事务安装器；`registry` 条目可用 `packagePath`（本地）或 `download`+`sha256`（HTTPS zip）。


---

## 6. 扩展界面的位置

| 声明 | 显示位置 | 用途 |
| --- | --- | --- |
| `status.chip` | 底部状态栏 | 额度、运行指标等简要状态，`details` 指向同包详情 |
| `composer.above` | 输入框上方 | 与本轮输入相关的状态或提醒 |
| `composer.below` | 输入框下方 | 项目或运行状态等简短信息 |
| `tool.view` | 悬浮工具面板 | 完整数据、操作或沙箱应用 |
| `status.detail` | 状态栏弹出层 | 状态摘要的详情 |
| `contributes.settings` | 「设置 → 插件 → 扩展」中该扩展的设置 | 扩展自己的说明、状态与操作 |

用 `slot` 或 `slots` 声明摘要支持的位置。设置页按清单提供位置、图标、配色和隐藏选项。额度按当前模型来源显示，Studio 指标在请求完成后继续显示最近一次的读数。

在插件目录选择「打开」可进入插件的工具标签。面板浮在工作区内容上方，收起即可继续输入，再打开可回到此前使用的标签。

工具视图默认可跟随 Studio 的亮暗模式、强调色和圆角。内容区使用画布底色，侧栏、卡片、输入框和浮层复用侧栏底色。插件作者可以直接使用宿主提供的 CSS 变量，另设的主题可由用户在插件内选择。[插件主题接入示例](../extensions/ui.md#在插件中跟随-studio-外观)

扩展的工具、命令、技能和 MCP 能力可独立于 UI 提供。扩展有独立管理页时，由 Studio 按清单渲染设置内容。需要详细面板、区块和动作的示例可查看 [声明式 UI](../extensions/ui.md)。

---

## 7. 信息架构（设置与市场）

### 7.1 插件管理

打开「设置 → 插件」即可浏览所有来源和本机已有的插件。同一插件只显示一张卡片。已安装的卡片带有「已安装」标记和启停开关。点击卡片可查看附带资源、进入资源设置或卸载插件。

可按名称、发布者或资源搜索，也可按来源和分类筛选。卡片上的「安装」或「更换版本」会先打开预览，展示包内容、版本和名称冲突。标签栏右侧的「本地安装」支持插件目录或压缩包。「添加源」支持 Registry JSON 和本地目录，「管理插件源」可启停或移除自定义来源。

### 7.2 设置 → 插件 的 Tab

```text
插件 | MCP | 技能 | 扩展
```

- **插件**：插件卡片目录、本地安装和插件源管理。
- **MCP**：用户手建 + 按插件分组的托管服务器；保留新建 / 导入。
- **技能**：Skill Hub 与已装列表；深链仍可用。
- **扩展**：独立 Extension 安装/启停/落点；内置能力折叠；声明式安装器仍在此分区。

页签位于设置页标题下方。命令面板、composer `settings.mcp`、会话扩展「管理扩展」、`openSettings('mcp'|'skills'|'extensions')` 均打开对应分区。

### 7.3 图标与视觉

- 插件列表和详情使用设置页的包图标。列表摘要显示版本、发布者和附带资源数量。
- 扩展可为视图和摘要声明 `icon` 与 `color`。[扩展 UI](../extensions/ui.md#给视图和摘要设置图标与配色)

---

## 8. 与现有文档的边界

| 文档 | 本文补充后如何读 |
| --- | --- |
| [resources.md](./resources.md) | 仍是 scope/存储/刷新权威；增加「插件归属」行后，以 resources 表为准实现存储列 |
| [extensions/*](../extensions/README.md) | 仍是 Extension 协议权威；落点枚举以本文 §6 为产品约束，schema 变更跟本文收敛 |
| [skill-hub.md](./skill-hub.md) | Skill 源与安装权威；插件 `provides.skills` 必须调用同一套安装器 |
| MCP 实现 | 配置表可增 `owner_plugin_id` 等列，不改 MCP 工具命名与 exposure 语义 |

---

## 9. 明确退出范围的产品能力

以下能力**不再作为 Pi Studio 产品表面**，文档与实现应删除，避免与插件/会话工作台继续纠缠：

| 能力 | 说明 |
| --- | --- |
| **模型双跑 / 模型比较** | 含比较工作台、比较会话分支服务、相关设置与存储键。多模型需求后续若有，另开设计，不走旧 comparison 代码。 |
| **视频分镜** | 含 `video-storyboard` 全链路、storyboard IPC、内置分镜 skill/资产、工作台入口与文档提及。 |

删除实现时要求：

- 去掉 UI 入口、IPC、preload、主进程服务、功能目录、测试与 README/网站提及；
- 不保留空壳兼容层（符合仓库「不为已删模块加兼容层」）；
- 用户本地若有分镜/比较缓存，可忽略或一次性清理，不在 UI 提示迁移。

---

## 10. 落地阶段（实现顺序）

| 阶段 | 交付 | 完成标准 |
| --- | --- | --- |
| **D0 约定** | 本文 + 索引链接 | ✅ 文档与索引已落地 |
| **D1 界面落点** | 会话摘要、工具面板和扩展设置 | 配置单一摘要位置，打开详情时保留对话 |
| **D2 归属** | MCP/Skill/Extension 可记录 `ownerPluginId`；MCP 列表按插件分组 | ✅ SQLite 归属列 + MCP 分组 UI；手工 `setMcpOwnership` 可验证 |
| **D3 本地插件包** | 目录/zip 安装 `provides`；详情展示本包提供；事务安装 | ✅ 本地目录/zip、归属写入、设置「插件」页、`examples/plugins/toolkit-starter` |
| **D4 市场** | 官方 registry + 卡片浏览 + 搜索 + 详情 | ✅ 官方目录、源管理、卡片/搜索/详情、市场安装 |
| **D5 设置整合** | 设置 → 插件（插件/MCP/技能/扩展） | ✅ 侧栏只留「插件」；四子 Tab；深链 mcp/skills/extensions 重定向 |
| **D6 清理** | 删除模型双跑与视频分镜 | ✅ 功能树与接线已移除（测试见验证） |

D1 与 D6 可并行于 D2–D5，不阻塞插件模型。

| **体验打磨** | 技能/扩展归属标注；记住插件分区 | ✅ 设置技能与扩展展示「来自插件」；托管项卸载指向插件页；本地记住上次插件分区 |

---

## 11. 扩展作者速查（新约定）

1. 简短状态使用底部状态栏或输入框摘要，详情使用 `status.detail` 或 `tool.view`。
2. 声明 `status.chip` 时，用 `details` 关联同包详情。
3. 扩展自己的设置使用 `contributes.settings`，命令使用 `contributes.commands`。
4. 需要 MCP、Skill 或 CLI 配合时，用插件包统一分发。
5. 包图标使用顶层 `icon`，面板和摘要使用枚举内的 `icon` 和 `color`。

---

## 12. 修订记录

| 日期 | 说明 |
| --- | --- |
| 2026-11-23 | 初版：插件包装层、落点治理、市场与设置 IA、双跑/分镜退出范围、分期落地 |
| 2026-11-23 | 移除模型双跑与视频分镜代码 |
| 2026-11-23 | 明确 `provides.cli`：包内二进制与系统 CLI、PATH 注入、安全与详情展示、与 MCP/Skill 分工 |
| 2026-11-23 | D5：设置侧栏收敛为「插件」主入口；MCP/技能/扩展为插件页子 Tab；深链重定向 |
| 2026-11-23 | 体验打磨：技能/扩展归属标注、托管卸载引导、插件分区记忆 |
