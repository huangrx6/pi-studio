# Pi Studio 资源作用域、优先级与刷新

本文是 Pi Studio 跨资源配置的权威入口，统一说明指令、Harness、运行策略、模型、权限、工具、Skill、MCP、扩展、子 Agent 与界面偏好的作用域、存储位置、冲突规则、信任边界和生效时机。

Pi Durable 仍是唯一执行引擎。Studio SQLite 保存 Studio 自己的配置、投影和资源信任记录；Durable 保存会话、任务、文档、事件与运行状态。Studio 不读取或回写 `~/.pi`、Pi CLI 配置或另一套凭据目录。

扩展清单、贡献点、声明式 UI 与发行协议仍以 [扩展规范](./extensions.md)、[Extension UI 规范](./extension-ui.md) 和 [扩展发行规范](./extensions-distribution.md) 为准。本文只统一跨资源语义，避免在多个文档里重复维护一张不一致的 scope 表。

## 1. Scope 与通用规则

| scope | 含义 |
| --- | --- |
| 应用 / 全局 | 当前 Studio 用户目录下的所有工作区共享；通常对应 Studio SQLite 中的一条应用级设置或表。 |
| 工作区 | 按绝对、解析后的 `cwd` 精确匹配。一般不会从父目录继承，也不会自动扩展到该目录的子目录。 |
| 会话 | 按 Durable conversation ID 匹配，只影响该对话或长期任务本身。owned child conversation 有独立 ID；权限 hook 会额外显式评估父会话策略。 |
| 渲染进程本地 | 保存在 Electron renderer 的 `localStorage`，属于本机界面状态，不进入 Durable 请求。 |
| 运行时内存 | 只描述当前进程中的连接、工具目录、缓存或临时会话，应用退出后消失。 |

需要区分两种“项目”含义：

- **工作区 scope** 是用户当前打开的精确目录，例如 `/repo/apps/web`。把 `/repo` 里的 `.pi-studio/skills` 打开成 `/repo` 工作区后，不会自动供 `/repo/apps/web` 使用。
- **项目指令边界** 是唯一会沿目录层级向外查找的资源。Studio 从最近的 `.git` 或 `.pi-studio` 边界读取 `AGENTS.md`，再逐级加载到当前 `cwd`。

Studio 的一般原则是显式 scope 与显式优先级。不同资源的冲突规则并不相同，不能把“更具体一定覆盖更宽”套用到所有资源：

- Harness、子 Agent 和常规工作区覆盖使用更具体的值。
- Skill 同名冲突由固定的发现顺序决定。
- 权限会让所有 scope 的显式规则共同参与，并固定执行 `deny > ask > allow`。
- 扩展按运行时层级解析，但受保护的 `core` / `optional` 贡献不能被普通扩展替换。

## 2. 资源总表

| 资源 | 有效 scope | 存储 | 优先级 / 冲突规则 | 生效边界 |
| --- | --- | --- | --- | --- |
| 指令 | 应用 + 项目目录链 | `<userData>/AGENTS.md`；项目 `AGENTS.md`、`.pi-studio/AGENTS.md` | 全局最先；项目从最近边界到 `cwd`，同层根 `AGENTS.md` 后在 `.pi-studio`；后加载内容覆盖冲突 | 下一次模型请求 |
| Harness profile | 全局默认 + 精确工作区覆盖 | SQLite `studio.harness` | 工作区直接选择一个完整 profile；缺失时用全局 profile；`inherit` 删除工作区覆盖 | 保存后重载，下一次模型请求 |
| Durable 运行策略 | 应用 | SQLite `studio.runtime.policy` | 单一应用级策略，无工作区或会话覆盖 | 下一次执行边界 |
| 模型、凭据与默认值 | 应用；当前会话另有运行配置 | SQLite `model_providers`、`model_catalog`、`credentials`、`settings` | 默认值只用于新会话；已有会话保留自己的模型与 thinking | 模型运行时重建后，下一次请求 |
| 工具权限 | user + 精确工作区 + 精确会话 | SQLite `studio.permissions.policy` | 各层显式规则共同参与，固定 `deny > ask > allow`；模式默认值按会话、工作区、用户取最具体一层 | 下一次工具调用 |
| Agent 工具白名单 | 应用 | SQLite `studio.agent.tools` | 单一白名单；精确名称或 glob 命中已安装工具 | 下一次模型请求 |
| Skill | user + 精确工作区项目目录 | `<userData>/skills`、`<home>/.agents/skills`、工作区 `.pi-studio/skills`、`.agents/skills`；项目信任在 SQLite | 项目私有、项目通用、用户私有、用户通用；同名先发现者生效 | 下一次提示渲染；显式 `/skill:` 在提交前展开 |
| MCP server | 应用 | SQLite `mcp_servers` | 每台 server 独立配置；逐工具 exposure 覆盖 server 默认值；仍受 Agent 白名单过滤 | 配置保存后重连；下一次模型请求使用新目录 |
| 扩展 | builtin + user + 精确工作区 project | SQLite `studio_extensions`；用户与项目受管目录 | 运行时顺序为 `core → system → optional → user → project`；`core` / `optional` 受保护 | 设置操作立即重载；直接文件变化在下一次提交前校验 |
| 子 Agent 默认值 | user + 精确工作区 project | SQLite `studio.subagents` | project 已设置字段覆盖 user；仍未设置的字段继承父 Agent | 下一次创建子 Agent |
| 会话模型与 thinking | 会话 | Durable conversation 状态；Studio 只保存会话投影 | 会话选择覆盖新会话默认值；运行中修改排队到下一请求 | 下一次请求 |
| 界面偏好 | renderer 本地 | `localStorage`；原生主题和菜单栏另有 SQLite 镜像 | 不参与 Agent 决策；本机 renderer 状态优先 | 保存后立即 |
| 临时聊天 | 运行时内存 | Durable `MemoryStorage` | 不读取项目资源、不创建 Studio 会话投影 | 当前内存会话有效期 |

## 3. 指令：`AGENTS.md`

### 3.1 加载顺序

一次模型请求会组合应用级和项目级指令：

```text
<Studio userData>/AGENTS.md
<最近项目边界>/AGENTS.md
<最近项目边界>/.pi-studio/AGENTS.md
... 从边界逐级向下 ...
<cwd>/AGENTS.md
<cwd>/.pi-studio/AGENTS.md
```

规则如下：

1. 从 `cwd` 向上寻找最近的 `.git` 或 `.pi-studio` 边界。
2. 从该边界逐级加载到 `cwd`，不会越过最近边界再读取更上层仓库。
3. 每个目录内先读 `AGENTS.md`，再读 `.pi-studio/AGENTS.md`。
4. 全局文件最先，后续项目文件更具体；指令冲突时，后加载文件覆盖先加载文件。
5. 没有 `.git` 或 `.pi-studio` 标记时，项目范围只实际落在当前 `cwd`。
6. 最多加载 8 个文件，单文件最多 128 KiB，所有文件合计最多 256 KiB。超出限制的文件不会进入本次提示。

### 3.2 存储与信任

- 应用级指令固定为 `<Studio userData>/AGENTS.md`。Harness 设置页会显示绝对路径及 `present`、`missing` 或 `unreadable` 状态。
- 项目级指令直接来自工作区目录链，不复制到 Studio SQLite。
- 项目指令会自动进入提示，没有单独的“项目指令信任”按钮。打开来源不明的仓库前，应先检查其中的 `AGENTS.md` 与 `.pi-studio/AGENTS.md`。
- 指令是模型上下文，不会自行获得工具权限。它们不能绕过 Studio 的权限 hook、工作区边界或系统级保护。

### 3.3 刷新

`projectContext` section 在下一次模型提示渲染时重新读取文件与边界。修改指令后不需要重启，也不会追溯改写已经完成的 transcript；当前正在生成的请求保持原样，下一次请求使用新内容。

## 4. Harness 与运行策略

### 4.1 Harness profile

Harness profile 定义 Prompt section 开关、section 覆盖、自定义补充和逐工具 guidance。profile 定义保存在应用级 SQLite 的 `studio.harness` 中。

选择规则：

- 全局选择一个默认 profile。
- 每个精确工作区可以覆盖全局选择；该工作区没有覆盖时回退到全局 profile。
- 工作区选择的是一个完整 profile，不会把工作区 profile 与全局 profile 逐字段合并。
- 选择 `inherit` 会删除该工作区的覆盖记录，使其重新跟随全局 profile。
- 删除正在被工作区引用的 profile 时，这些工作区引用会一并清除，并重新继承全局选择。

`projectContext`、工具说明、Skill 元数据和仓库文档等动态 section 会在请求边界按当前工具、工作区和磁盘状态重新生成。设置页保存后运行时会重新加载；当前流式回复和已经开始的工具调用不被改写，下一次模型请求使用新的 profile。

### 4.2 Durable 运行策略

`studio.runtime.policy` 是纯应用级资源，覆盖请求超时、重试、上下文压缩、工具并行、失败后输入处理、崩溃恢复以及上下文 / 文档内存保留时间。

该策略没有工作区或会话层。Durable 通过同步 getter 在每个执行边界读取最新值，因此保存后不要求重开 Harness。当前正在执行的阶段继续使用已经取得的策略，后续边界读取新值。

### 4.3 工具并行不是权限

`toolExecution: "parallel"` 只表示同一模型轮次里的独立工具可以并发启动。具体工具仍可声明自身为顺序执行；是否允许工具运行仍由 Agent 工具白名单和权限策略分别决定。

## 5. 模型、会话与界面偏好

### 5.1 模型目录与凭据

模型来源、模型目录、启停状态、发现地址、能力字段、API Key 和默认值全部属于应用级 Studio 数据：

- `model_providers`：来源、Base URL、API 类型、图标、发现地址和启停状态。
- `model_catalog`：模型 ID、上下文、输出上限、图片 / thinking 能力、启用状态和覆盖来源。
- `credentials`：按 provider 保存凭据，值使用 Electron `safeStorage` envelope 加密。
- `studio.models.defaultModelRef`：新会话默认模型。
- `studio.models.defaultThinkingLevel`：新会话默认 thinking。
- `studio.models.thinkingByModel`：按模型保存的 thinking 偏好；存在时优先于全局 thinking 默认值。

渲染进程只拿到“是否已配置凭据”和脱敏后的模型信息，不会收到明文密钥。Agent 扩展只有在 manifest 声明 `provider.credentials`、获得用户同意且 provider 在 `providerAccess` 范围内时，才可通过受控 capability 读取对应凭据。

默认模型和默认 thinking 只用于创建新会话。已有会话继续保存自己的选择。模型目录、来源和凭据保存后会重建 Studio 模型运行时；下一请求可看到新目录和新凭据，当前请求不被改写。

### 5.2 会话模型与 thinking

每个 Durable conversation 在 agent 配置中保存模型和 thinking。当前会话切换优先于应用默认值。会话正在运行时提交切换，会排队到下一请求生效；当前流式输出不会因切换被重写。

模型或 thinking 偏好必须得到该模型支持。Studio 对不支持的值回退到可用的 `medium`、模型首个支持的 thinking level，或 `off`。

### 5.3 临时聊天

临时聊天使用独立 `MemoryStorage` 和空 registry：

- 不写入 Studio SQLite、JSONL、工作区文件、凭据附件或会话历史。
- 不使用 Agent 工具，也不加载项目指令、Skill、扩展或 MCP。
- 可以读取应用级模型运行时中的已配置模型与凭据。
- 关闭最后一个临时聊天或退出应用后，transcript、图片和临时运行状态随之消失。

### 5.4 Renderer 界面偏好

字号、主题、强调色、背景、步骤展示、链接打开方式和繁忙时发送行为主要保存在 renderer `localStorage` 的 `pi-studio:preferences`。侧栏展开状态、手动排序、最近会话、筛选和面板宽度也保存在 renderer 本地。

这些偏好不参与模型请求，也不会跨工作区切换。主题与 palette 同时镜像到应用级 SQLite，供原生窗口和启动阶段使用；菜单栏开关保存在 `studio.app.menuBarEnabled`。界面偏好保存后立即应用，不需要重载运行环境。

## 6. 工具权限

### 6.1 三个 scope

权限策略位于 SQLite `studio.permissions.policy`：

```text
user
workspace[精确 cwd]
session[精确 conversation ID]
```

工作区层只匹配精确 `cwd`。会话层只匹配当前会话 ID。子 Agent 的工具调用会同时评估子会话与父会话的权限，并采用更严格的结果。

### 6.2 冲突规则

权限不是“后一层全部覆盖前一层”：

1. 系统危险命令、可识别的越界 Bash 写入，以及 `write` / `edit` 写入当前工作区之外属于硬保护，直接阻止。
2. 收集 user、workspace、session 三层中所有命中的显式工具规则和详细规则。
3. 所有命中的显式决定共同参与，固定优先级为 `deny > ask > allow`。会话层的 `allow` 不能压过 user 或 workspace 层的 `deny`。
4. 没有显式规则命中时，才使用最具体现有策略层的模式默认值；默认值 scope 顺序为 session、workspace、user。
5. `read`、`ls`、`find`、`grep` 访问工作区外时默认要求确认；显式路径规则可以允许特定读取。无法静态确认边界的 Bash 写入等保护仍可要求确认，`full` 也不能绕过第 1 步的硬保护。

`smart` 和 `full` 会对 `read`、`ls`、`find`、`grep`、`tool_search` 等明确只读工具应用安全快捷规则；其他未知工具继续使用对应策略模式。

| 模式 | 默认行为 |
| --- | --- |
| `ask` / 请求批准 | 普通工具逐次确认。 |
| `smart` / 帮我批准 | 明确只读工具自动允许，风险或未知工具仍确认。 |
| `full` / 完全权限 | 普通工具、跨工作区操作和动态脚本默认允许；显式 `ask` / `deny`、明显删除和系统破坏保护继续生效。 |

### 6.3 记住批准与刷新

记住批准会生成范围尽可能窄的规则：

| 选项 | 持久化位置 |
| --- | --- |
| 仅本次 | 不保存 |
| 本会话 | `sessions[sessionId]` |
| 本工作区 | `workspaces[cwd]` |
| 始终 | user 规则 |

命令规则使用精确命令或命令前缀，文件规则使用精确路径或 glob。长命令、无法安全缩窄的命令或工作区外路径可能只提供更保守的批准范围。

权限 hook 在每次工具调用前重新读取 SQLite。修改模式、规则或记住批准后，同一个正在运行的请求中的下一次工具调用即可生效，无需重开会话。

权限检查和文件边界是产品级防护，不是操作系统沙箱。Bash 的越界识别是静态检查，无法覆盖所有 shell 语义；来自不受信任来源的代码和命令仍应按不可信内容处理。

## 7. Agent 工具白名单

Agent 工具白名单保存在应用级 SQLite `studio.agent.tools`。Studio 只有一个全局白名单，没有独立的 user、workspace 或 project 白名单。

选择过程是：

1. Durable registry 提供当前实际安装且可用的工具。
2. 白名单用精确名称或 `*` glob 选择其中可提供给模型的子集。
3. MCP、扩展启停、项目信任和工作区可见性继续限制 registry 中是否存在该工具。
4. 被选中的工具在真正执行前仍须通过第 6 节的权限 hook。

因此“工具在白名单中”不等于“工具获准执行”；“权限规则允许某工具”也不等于该工具已安装或被白名单选中。两者必须同时成立。

白名单最多 256 项，支持精确名称和 glob。保存后会刷新运行选择；当前请求和已经开始调用保持原样，下一模型请求使用新集合。

## 8. Skill

### 8.1 发现位置与优先级

Skill 使用精确工作区目录，不从父目录向上查找。同名 Skill 由以下固定顺序决定：

| 顺序 | scope | 位置 |
| --- | --- | --- |
| 1 | project | `<workspace>/.pi-studio/skills` |
| 2 | project | `<workspace>/.agents/skills` |
| 3 | user | `<Studio userData>/skills` |
| 4 | user | `<home>/.agents/skills` |

每个位置递归查找 `SKILL.md`。目录一旦包含 `SKILL.md` 就作为 Skill 根，不再向下把它当作技能集合扫描。同名冲突保留先发现的 Skill，并把其余路径写入诊断。目录名、名称与 frontmatter 必须满足 Agent Skills 约束；缺少可解析 description 的 Skill 会被跳过。

### 8.2 信任

- 用户 Skill 默认信任。
- 项目 `.pi-studio/skills` 与项目 `.agents/skills` 默认不信任。
- 信任记录保存在 SQLite `project_resource_trust`，按工作区、资源类型和规范路径定位，并保存完整目录内容指纹。
- 指纹覆盖隐藏文件、文件内容、文件模式 / 权限与符号链接；Studio 同时用文件元数据签名判断是否需要重新计算完整内容哈希。项目 Skill 中的符号链接必须留在工作区内。
- 任一内容或链接变化后旧信任立即失效，Skill 在下一次发现时变为不可用，必须重新检查并信任。
- `.agents/skills` 是跨客户端互操作目录，Studio 只发现；Studio 的“添加技能”写入 `.pi-studio/skills` 或 Studio userData。

### 8.3 注入与刷新

提示中只放 `name`、`description` 和绝对 `SKILL.md` 路径；模型在任务需要时通过本次开放的 `read` 或 `bash` 读取正文。两者都没有开放时，不注入自动 Skill 路由提示。

`disable-model-invocation: true` 只隐藏自动路由；`/skill:<name>` 仍可在提交前显式展开正文。项目 Skill 必须已信任，否则显式命令也会失败。

自动发现和元数据在每次模型提示渲染时读取，所以同一 run 的下一模型请求能看到新增、删除或修改。显式 `/skill:` 在提交输入前立即读取并展开。已经进入 transcript 的正文不会因磁盘后续变化被追溯重写。

`SKILL.md` 单体上限为 2 MiB；完整目录另有条目数、深度、单文件与总大小预算。这些限制用于约束发现和指纹计算，不构成代码沙箱。

## 9. MCP

### 9.1 Scope 与 exposure

MCP server 全部是应用级共享连接，保存在 SQLite `mcp_servers`，没有 workspace 或 project 配置层。stdio server 的 `cwd` 只是子进程工作目录和 MCP roots 提示，不改变 Studio 资源作用域。

每台 server 有一个默认 exposure：

- `direct`：工具直接进入模型可用集合。
- `deferred`：模型先看到目录和摘要，通过 `tool_search` 按需加载。
- `hidden`：不允许模型直接调用，只供其他工具通过 `executeTool()` 使用。

逐工具精确覆盖优先；没有精确项时使用第一个匹配的 glob，最后才使用 server 默认值。所有 MCP 工具仍受应用级 Agent 工具白名单和权限策略双重过滤。

### 9.2 存储与安全

- server 定义、启停、exposure、逐工具覆盖、超时、stdio `cwd`、env 和 headers 位于 `mcp_servers`。
- env 与 header 值使用 Electron `safeStorage` envelope 加密；renderer 只得到键名。
- 配置值中的 `${ENV_NAME}` 会从 Studio 主进程环境解析；Studio 不执行 `!command`。
- stdio 子进程只继承定位命令和临时目录所需的少量环境变量，不自动继承其他 shell secret。
- 未配置 stdio `cwd` 时使用 Studio userData，不依赖打包后的 `process.cwd()`。
- HTTP endpoint 必须是 HTTPS；只有 `localhost`、`127.0.0.1` 和 `::1` 允许 HTTP 开发。
- 连接状态、工具目录、stderr 与错误属于当前进程状态，不写回配置表。

### 9.3 刷新

保存、启用、禁用或删除配置后立即重连或重建 MCP registry。活动模型请求与已经开始执行的 MCP 工具调用不被替换；旧 client 进入退休态，等活动调用结束后关闭。

server 发出 `notifications/tools/list_changed` 时只刷新该 server 的工具目录。新工具在下一次模型请求边界可见。`deferred` 工具一旦被搜索加载，其选择写入该会话分支，后续请求和分叉继续可见。

MCP 文本结果超过 20 KiB 时会保留首尾，并把完整输出写到临时文件。连接、工具调用和输出转换仍是独立外部进程能力，不是 Agent 扩展的 Node 沙箱替代品。

## 10. 扩展

### 10.1 来源与存储

| scope | 受管代码位置 | 信任默认 | 运行范围 |
| --- | --- | --- | --- |
| `builtin` | Studio 内置运行时，登记在 SQLite `studio_extensions` | 信任 | 所有工作区 |
| `user` | `<Studio userData>/extensions/<id>/<version>` | 信任 | 所有工作区 |
| `project` | `<workspace>/.pi-studio/extensions/<id>/<version>` | 不信任 | 当前精确工作区 |

受管安装的活动版本指针、回滚状态和逐文件摘要放在 `<userData>/extension-state`；跨版本运行数据放在 `<userData>/extension-data`；quarantine 位于 `<userData>/extension-cache/quarantine`。直接放在扩展目录中的非受管扩展使用自身目录下的 `.data`。

用户扩展和项目扩展可以使用相同 manifest ID，因为它们拥有不同的稳定 ID：

```text
user:<manifest-id>
project:<manifest-id>
project:<manifest-id>/<contribution-id>
```

### 10.2 运行时优先级

同名贡献按以下层级顺序装配，后者可以在普通冲突中覆盖前者：

```text
core → system → optional → user → project
```

- `core` 与 `optional` 内置工具受保护。普通扩展声明同名工具会生成错误诊断，整个冲突扩展不会进入运行时。
- `system` 工具允许更高层有意替换，但始终显示冲突诊断。
- project 扩展与 user 扩展同名时，project 作为当前工作区的运行时覆盖；不会合并或改写 SQLite 中 user 贡献的稳定 ID。
- UI `priority` 只控制同一 slot 内的排序，数值高者在前，同值按稳定 ID 排序。它不是资源 scope、权限或覆盖优先级。

### 10.3 信任与安全

- builtin 默认启用并信任，`core` 不能停用。
- 用户扩展安装后默认信任。
- 项目扩展默认不信任，声明式 UI 扩展也不例外。设置页必须展示来源、版本、真实路径、权限和贡献，再由用户信任。
- 项目扩展的信任绑定完整内容指纹。升级、回滚或直接修改代码、入口、依赖和链接后，如果内容变化，旧信任会被撤销。
- 有活动依赖者的扩展不能被停用、撤销信任或卸载；应先处理依赖链。
- UI 扩展只提交清洗后的 JSON-safe DTO，renderer 不执行扩展 HTML、CSS、JavaScript、React 或任意 IPC。
- Agent 扩展在 Electron 主进程执行受信任 Node 代码。manifest 权限用于契约校验、来源展示和同意流程，不是 OS 沙箱；`network` 标记也不能阻止网络访问。

### 10.4 刷新

- 设置页保存、安装、升级、回滚、启停、信任变化和卸载会立即重建 registry。
- 新 section、tool、hook、task 和 UI 贡献从下一模型请求或下一次 UI 读取开始可见。
- 已经开始执行的工具保留开始时的实现；当前 task phase 保留该 phase 开始时的 hook 与 agent。
- 直接修改项目扩展文件时，Studio 在下一次创建会话或提交任务前重新验证完整性并重载。被篡改或变化的代码不会继续沿用旧信任。
- 禁用、撤销信任或卸载后，贡献立即从新请求消失；历史 transcript 中的旧工具结果继续作为历史事实展示。

## 11. 子 Agent

子 Agent 配置保存在 SQLite `studio.subagents`：

```text
studio.subagents.user
studio.subagents.projects[精确 cwd]
```

运行时按字段合并：project 已设置的值覆盖 user，未设置的字段继续继承 user；模型和 thinking 两级都没有配置时继承父 Agent。

主要字段的语义：

- `defaultModel` / `defaultThinking`：新子 Agent 的默认模型与 thinking。
- `maxThinking`：限制子 Agent 请求可使用的 thinking 上限。
- `allowedTools`：非空时与父 Agent 当前工具求交集，并排除递归子 Agent 的管理工具；空列表表示不增加子 Agent 专属白名单。
- `backgroundEnabled`、`defaultMode`、`supervisorEnabled`、并发数、派生上限和等待超时：控制子 Agent 的派生与后台运行行为。

子 Agent 是 task-owned Durable child conversation，不是 Studio 侧边栏中的独立会话。配置只在下一次创建子 Agent 时读取；修改设置不会重配置已有子 Agent。子 Agent 工具仍经过自身和父会话的权限评估。

## 12. 存储边界

```text
Pi Studio userData/
├── AGENTS.md                 # 应用级 Harness 指令
├── pi-studio.sqlite
│   ├── durable_*             # Pi Durable 的会话、任务、文档、事件与用量
│   ├── conversations         # Studio 会话 / 长期任务投影
│   ├── workspaces            # Studio 工作区记录
│   ├── settings              # Harness、模型默认值、权限、工具、子 Agent、界面设置
│   ├── model_providers       # 模型来源
│   ├── model_catalog         # 模型目录与启停
│   ├── credentials           # safeStorage 加密凭据
│   ├── mcp_servers           # 应用级 MCP 配置
│   ├── studio_extensions     # 扩展登记与信任状态
│   └── project_resource_trust # 项目 Skill 等资源的路径 + 内容指纹
├── skills/                   # Studio 用户级 Skill
├── extensions/               # Studio 用户级扩展代码
├── extension-state/          # 受管安装、活动版本与回滚状态
├── extension-data/           # 受管扩展跨版本运行数据
└── extension-cache/          # 导入 quarantine 等缓存

<home>/.agents/skills/        # 跨客户端通用用户 Skill

<workspace>/
├── AGENTS.md                 # 精确工作区根指令
├── .pi-studio/
│   ├── AGENTS.md             # Studio 项目指令
│   ├── skills/               # 项目 Skill
│   └── extensions/           # 项目扩展代码与受管版本指针
└── .agents/
    └── skills/               # 跨客户端通用项目 Skill
```

`pi-studio.sqlite` 同时承载 Durable 与 Studio 的表，但使用不同前缀和表名。临时聊天、MCP 连接状态和工具目录不进入持久数据树。

## 13. 安全边界总览

| 资源 | 主要信任措施 | 不能保证的内容 |
| --- | --- | --- |
| 指令 | 明确显示全局路径与项目加载链，后加载规则透明 | 项目文件会自动进入提示；不存在自动信任批准 |
| Skill | 项目完整目录指纹、工作区内 realpath、用户显式信任 | Markdown 仍可影响模型行为；指纹只检测变化，不做签名审计 |
| MCP | Secret envelope 加密、最小环境继承、HTTPS / loopback 规则 | server 是外部进程或服务，不是沙箱 |
| Agent 扩展 | 默认信任策略、项目指纹、manifest / 入口 / 链接 containment | 受信任 Node 代码拥有主进程能力 |
| UI 扩展 | JSON-safe DTO、递归清洗、固定组件与 token | 不能直接访问文件、数据库、凭据或任意 IPC |
| 权限 | 多 scope 显式规则、硬保护、逐工具复核 | Bash 静态分析覆盖有限，不是 OS 沙箱 |
| 凭据 | Electron `safeStorage`、主进程 capability、renderer 脱敏 | 获得 capability 的受信任扩展仍可按授权读取对应 provider |

Studio 不把内容哈希、路径校验、HTTPS 或静态命令检查描述为操作系统级隔离。需要真正隔离不可信代码时，应使用独立进程、容器或其他 OS 沙箱方案。

## 14. 修改后的生效时机

| 修改 | 何时生效 |
| --- | --- |
| 修改全局或项目 `AGENTS.md` | 下一次模型请求 |
| 保存 Harness profile / 工作区 profile 选择 | 设置保存后重载；下一次模型请求 |
| 修改 Durable 运行策略 | 下一次执行边界 |
| 修改模型来源、目录、启停或凭据 | 模型运行时重建后，下一次请求 |
| 修改默认模型 / thinking | 下一次创建会话 |
| 切换当前会话模型或 thinking | 下一次请求；运行中切换排队 |
| 修改权限模式、规则或记住批准 | 下一次工具调用 |
| 修改 Agent 工具白名单 | 下一次模型请求 |
| 新增、删除或修改 Skill | 下一次模型提示渲染；显式 `/skill:` 在提交前 |
| 修改 MCP 配置 | 立即重连；下一次模型请求使用新目录 |
| 安装、升级、启停、信任或卸载扩展 | 立即重载；下一次模型请求 / UI 读取 |
| 直接修改项目 Skill 或扩展文件 | 下一次发现或提交前校验，必要时撤销信任 |
| 修改子 Agent 配置 | 下一次创建子 Agent |
| 修改 renderer 偏好 | 立即 |

## 15. 常见误解

### 父目录的 Skill、扩展或工具权限为什么没有生效？

这些工作区资源按精确 `cwd` 匹配。请把工作区切换到实际包含 `.pi-studio` 的目录，或把资源放到当前工作区的对应位置。不要依赖 Git 根目录自动继承；只有项目 `AGENTS.md` 使用目录边界加载规则。

### 会话允许了工具，为什么仍然被询问或拒绝？

先检查所有 scope 的显式规则。任一层命中 `ask` 会压过其他层的 `allow`，任一层命中 `deny` 会压过 `ask` 和 `allow`。随后按当前模式检查边界：`ask` / `smart` 会提示跨工作区与无法静态确认的 Bash 操作，`full` 只拦截明显的删除和系统危险命令。

### 工具权限允许了，为什么模型看不到工具？

权限规则不解锁未安装的工具。检查扩展 / MCP 是否启用、项目资源是否信任、当前工作区是否可见，以及 `studio.agent.tools` 白名单是否选中该工具。

### 项目扩展或 Skill 为什么显示不可用？

项目资源默认不信任。确认来源和内容后执行信任；如果文件或链接发生变化，需要重新审查并信任。未信任的同名项目 Skill 也可能占用发现优先级并产生冲突诊断。

### 为什么修改 MCP 或扩展后当前回复没有变化？

Studio 不重写正在生成的模型请求，也不替换已经开始的工具实现。新配置在下一模型请求或下一次工具 / task phase 生效。

### 为什么已有会话没有采用新的默认模型？

默认模型和默认 thinking 只用于新会话。已有会话保留自己的运行配置，需要在当前会话显式切换。

## 16. 相关文档

- [扩展规范](./extensions.md)：manifest、贡献点、权限声明、UI、扩展信任与发行契约。
- [Extension UI 规范](./extension-ui.md)：声明式 component、slot、data source 与 action。
- [扩展发行规范](./extensions-distribution.md)：本地目录、ZIP、HTTPS、GitHub Release、registry、安装与回滚。
- [扩展能力审查](./extensions-audit.md)：内置能力边界与审查结论。
- [README](../README.md)：产品概览、数据边界与开发命令。

新增跨资源配置时，应同时确认本文总表、资源专节和对应实现测试；扩展协议字段本身继续维护在扩展规范中。
