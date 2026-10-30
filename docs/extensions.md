# Pi Studio 扩展规范

本文定义 Pi Studio `format: 1` 的扩展清单、权限、贡献点、UI 数据、运行方式与热加载语义。实现以 [studio-extensions.cjs](../electron/services/studio-extensions.cjs) 为准，机器可读校验文件是 [pi-studio.extension.schema.json](../schemas/pi-studio.extension.schema.json)。

跨资源的 scope、优先级、存储与刷新时机以 [资源作用域、优先级与刷新](./resources.md) 为准。本文保留扩展协议、贡献点、信任和发行实现细节。

Pi Studio 的扩展分为两层：

- **Agent 扩展**在 Electron 主进程中运行受信任的 Node.js 模块，通过 Pi Durable 提供 tools、sections、hooks 和 tasks。
- **UI 扩展**只提交 JSON 安全的声明式内容。渲染进程不会收到 HTML、CSS、JavaScript、React 组件、Electron 对象或任意 IPC 能力。

两层可以写在同一个扩展中，也可以只实现其中一层。扩展契约面向普通主进程和 renderer；扩展不应读取 `~/.pi`、Pi CLI 配置或另一套宿主 API。

## 1. 目录与清单

扩展作者在开发目录中至少提供：

```text
my-extension/
├── pi-studio.extension.json
└── extension.mjs           # 仅 Agent 扩展需要
```

受管安装目录：

```text
<Studio userData>/extensions/<manifest-id>/<version>/       # 用户范围代码
<Studio userData>/extensions/<manifest-id>/current.json     # 活动版本指针
<workspace>/.pi-studio/extensions/<manifest-id>/<version>/  # 项目范围代码
<workspace>/.pi-studio/extensions/<manifest-id>/current.json

<Studio userData>/extension-data/user/<manifest-id>/        # 用户范围运行数据
<Studio userData>/extension-data/project-<hash>/<manifest-id>/
```

清单必须位于所选目录根部。`runtime.durableEntry` 必须指向扩展目录内的 `.js` 或 `.mjs` 文件；`..`、绝对路径和通过符号链接逃出扩展目录的入口都会被拒绝。扩展不得把缓存或用户数据写入版本代码目录，`activate()` 提供的 `dataDirectory` 才是可持久化目录。

Studio 先把本地目录、ZIP、HTTPS、GitHub 或 registry 来源复制到 quarantine，完成清单、依赖、兼容性、权限差异和逐文件摘要校验后才展示安装预览。安装器使用版本目录和活动指针原子切换；同一版本不可覆盖。升级通过同一套 `prepare → consent → installPrepared` 流程完成，并保留历史版本供回滚，不需要先卸载。完整流程见 [扩展发行规范](./extensions-distribution.md)。

## 2. Manifest

最小 UI-only 示例：

```json
{
  "format": 1,
  "id": "team-tools",
  "name": "Team Tools",
  "version": "1.0.0",
  "description": "Team-specific actions",
  "author": "Example Team",
  "permissions": ["ui.panels", "ui.commands"],
  "contributes": {
    "commands": [
      {
        "id": "open-checklist",
        "title": "打开检查清单",
        "placement": "composer",
        "action": {
          "kind": "openPanel",
          "panelId": "checklist-detail"
        }
      }
    ],
    "panels": [
      {
        "id": "checklist-detail",
        "title": "发布检查",
        "slot": "conversation.detail",
        "size": "regular",
        "content": [
          { "kind": "heading", "text": "发布前" },
          { "kind": "list", "items": [
            { "text": "运行测试" },
            { "text": "更新 CHANGELOG" }
          ] },
          { "kind": "notice", "tone": "info", "text": "项目扩展需要手动信任。" }
        ]
      },
      {
        "id": "checklist-summary",
        "title": "检查进度",
        "slot": "conversation.footer",
        "size": "compact",
        "content": [
          { "kind": "text", "text": "发布检查 · 2 项待完成" }
        ]
      }
    ]
  }
}
```

Agent 扩展示例：

```json
{
  "format": 1,
  "id": "review-tools",
  "name": "Review Tools",
  "version": "1.0.0",
  "permissions": ["agent.tools", "agent.sections", "ui.commands"],
  "runtime": {
    "durableEntry": "extension.mjs"
  },
  "contributes": {
    "tools": [
      {
        "name": "review_checklist",
        "description": "Read the repository review checklist."
      }
    ],
    "commands": [
      {
        "id": "review",
        "title": "开始代码审查",
        "placement": "composer",
        "argumentHint": "[focus]"
      }
    ]
  }
}
```

规则：

- `format` 当前只能为 `1`。不兼容变更会提升 format，而不是悄悄改变字段含义。
- `id` 长度为 2–64，只允许小写字母、数字、点、横线和下划线，且不能使用原型敏感名称。
- `version` 由扩展作者维护，建议使用语义化版本。
- `tier` 只用于 Studio 内置扩展。用户和项目扩展不能自行声明 `core`、`system` 或 `optional`；宿主会根据安装范围设置 `user` 或 `project`。
- `permissions` 必须准确声明贡献点所需能力。未声明权限的贡献会被拒绝。
- 用户范围和项目范围可以有相同的 manifest ID；它们是两个独立安装。
- 同一范围内的 manifest ID 必须唯一。
- tools、commands、panels、settings 和 composer 各自不能出现重复身份；commands、panels、settings 与 composer 共用同一个可寻址贡献命名空间，跨类型重复也会被拒绝。
- 未知 contribution 类型、未知权限、未知 slot、非法 action、格式错误或超出上限的内容会让 manifest 加载失败；错误会带 `kind[index]` 定位，不再静默丢弃。

## 3. 权限

| 权限 | 能力 |
| --- | --- |
| `agent.tools` | 向 Durable registry 注册模型可调用的工具 |
| `agent.sections` | 向系统提示词贡献 section |
| `agent.hooks` | 监听或拦截 Durable task 阶段 |
| `agent.tasks` | 注册可持久化 Durable task |
| `ui.commands` | 注册命令和 composer 命令 |
| `ui.panels` | 注册声明式 slot 内容与面板 |
| `ui.settings` | 在设置页注册声明式内容 |
| `ui.data` | 通过 Durable provider 向已挂载的声明式 view 提供受控实时数据 |
| `network` | 声明扩展会访问网络；这是审计标记，不是网络沙箱 |

声明任何 `agent.*` 权限或 `ui.data` 时，必须提供 `runtime.durableEntry`。只使用静态 `ui.commands`、`ui.panels`、`ui.settings` 时不需要运行时代码。

Agent 扩展是受信任的 Node 代码。权限用于契约校验、安装审计和能力来源展示，不能把任意 Node 模块变成安全沙箱。不要安装来源不可信的 Agent 扩展。

项目扩展默认不受信任。项目扩展升级或回滚后，如果活动版本的 tree SHA-256 发生变化，Studio 会撤销旧内容的信任；即使依赖扩展仍在启用，也不会继续以旧授权运行新代码。用户必须重新审查内容并手动信任。相同版本的完整性一致重放不会改变信任状态。

### Studio 工具权限模式

manifest 的 `permissions` 描述扩展能贡献哪些能力；Studio 的 `ask`、`smart`、`full` 是另一层产品级工具执行策略，控制 Agent 调用工具时是否需要用户批准。它们可以按全局、工作区和当前会话配置，不写入扩展 manifest，也不能由扩展自行提升。

- `ask`：除显式放行规则外，工具调用进入审批。
- `smart`：只读、低风险操作可按内置策略放行，写入、命令和敏感路径仍按规则审批。
- `full`：在 Studio 的硬性安全边界内自动批准，不再逐次询问。

每条策略使用 `allow`、`ask` 或 `deny`，可按工具 glob、命令前缀或精确命令、精确路径、路径 glob、工作区内路径和 MCP 工具匹配。全局、工作区和会话中所有命中的显式规则会共同参与裁决，优先级固定为 `deny > ask > allow`；未命中规则时才使用最具体的模式默认值。系统危险命令和工作区越界检查不会被 `full` 绕过。永久批准保存到 Studio SQLite，临时批准只影响当前会话。保存后下一次工具调用即读取新策略，不需要重启应用。

审批钩子绑定在 Durable `ToolTask`，因此模型直接调用、`mcp__*` 工具和父工具通过 `executeTool()` 发起的 nested ToolTask 都走同一套策略。全局、工作区和会话覆盖会在每次工具调用前重新读取；同一个正在运行的会话切换模式后，下一次工具调用立即采用新策略，已经开始的确认框和工具调用不会被中途改写。

### Bash 边界检测的限制

`full` 仍会对可识别的 Bash 越界写入执行硬拦截，包括重定向、`tee`、`cp`/`mv`、常见直接修改命令，以及 `bash -c`、`env` 包装器和外部脚本入口。无法可靠解析的动态目标或脚本执行会要求确认；显式规则可以进一步允许或拒绝具体命令。

这是保守的静态启发式检查，不是 OS 沙箱，也不能证明任意进程无法写到工作区外。shell 展开、函数或别名、`eval`、编译程序、包脚本、未识别的包装器、运行时生成的路径，以及先 `cd` 再写入等组合都可能绕过静态分析。需要强隔离时应使用操作系统沙箱、容器或受限账户，或者不要提供 `bash` 工具。

## 4. 稳定贡献 ID

所有可寻址贡献使用：

```text
<scope>:<manifest-id>/<contribution-id>
```

例如：

```text
user:review-tools/review
project:review-tools/review
builtin:studio-subagents/subagent
```

scope 是 ID 的一部分，因此用户扩展和项目扩展可以同名共存。UI action 中出现的 `panelId` 和 `commandId` 都必须指向当前扩展自己的贡献，完整 ID 是可选的显式写法；跨扩展引用会被拒绝。项目扩展覆盖用户扩展时只能改变运行选择，不能改写已持久化的贡献 ID。

## 5. Tools

Agent 扩展在入口模块中创建 Durable extension：

```js
import {
  defineExtension,
  defineTool,
  Type,
} from '@earendil-works/pi-durable';

const checklist = defineTool({
  name: 'review_checklist',
  description: 'Read the repository review checklist.',
  parameters: Type.Object({ path: Type.Optional(Type.String()) }),
  replay: 'safe',
  async execute(args, api, context) {
    const agent = await api.agent(context);
    const target = args.path || '.pi-studio/REVIEW.md';
    return {
      output: [{ type: 'text', text: `Review ${target} from ${agent.cwd}` }],
    };
  },
});

export const durableExtension = defineExtension({
  name: 'review-tools',
  tools: [checklist],
});
```

需要从 Studio 设置读取能力时使用 `activate(context)`：

```js
export async function activate(context) {
  // context: apiVersion, extensionId, manifestId, scope, manifest, dataDirectory
  return {
    durableExtension,
    commands,
    cleanup() {
      // 清理 timer、listener、数据库连接或后台 client。
    },
  };
}
```

`activate()` 不得把 Durable 扩展之外的 Electron 对象交给 renderer。它收到的 manifest 是清洗后的副本。

扩展可以在 `activate()` 返回值中提供 `cleanup()`，也可以从入口模块导出
`deactivate(context)`。Studio 在热重载、停用、撤销项目信任、回滚和卸载前都会调用这些
清理函数；每个函数只执行一次，单个清理抛错或超时不会阻止其他扩展继续卸载。

同名工具按 `core → system → optional → user → project` 顺序解析。`core` 和 `optional` 内置扩展的工具贡献受保护：普通扩展声明同名工具时会产生错误诊断，整个冲突扩展不会进入运行时，避免借由工具名替换安全守卫或可选能力。`system` 内置工具可以按文档中的运行时能力由更高层有意替换，并始终显示冲突诊断。

内置扩展不能从受支持的设置与管理接口删除。`core` 不能停用；`optional` 可以在没有启用的依赖者时停用，也可以重新启用。安装阶段会重新写入内置记录；普通扩展使用 scope 前缀，不能以同 ID 覆盖这些受保护条目。工具被卸载后，旧 transcript 中的调用和结果仍保留用于展示，但新请求不会再提供该工具。

子智能体必须通过 Durable 的 `api.commit()` 创建 `ownership: { kind: "task", taskId: api.taskId }` 的 child conversation，不能用普通 ownerless 会话冒充。可配置工具白名单是父智能体当前 model tools 与白名单的交集，且始终排除递归的 `subagent` 工具；没有交集时在创建 child 前失败。父会话取消或工具任务失败时，由 Durable 的 ownership cascade 终止 child；工具还会在提交前后检查 `abortSignal`，避免取消后继续等待或返回成功结果。

## 6. Commands

命令可以只有声明式 action，也可以由 Agent 代码处理。

```js
export const commands = {
  async review({ extensionId, sessionId, cwd, input }) {
    return {
      message: `开始审查：${input || cwd}`,
      promptText: `请按照代码审查清单检查当前改动。\n${input}`,
      submit: false,
    };
  },
};
```

入口模块可以同时导出 `durableExtension` 和 `commands`，也可以由 `activate()` 返回 `{ durableExtension, commands }`。`commands` 只能包含 manifest 中声明且没有 `action` 的命令；传给 Durable registry 的扩展对象不会包含该字段。

命令声明：

```json
{
  "id": "review",
  "title": "开始代码审查",
  "description": "根据当前改动生成审查提示词",
  "placement": "composer",
  "argumentHint": "[focus]"
}
```

placement：

- `composer`：输入框 `/` 菜单。
- `command-menu`：通用命令菜单。
- `session`：会话级动作。
- `workspace`：工作区级动作。

`argumentHint` 不是静态文本的替代品。用户在输入框执行 `/review security` 时，Studio 把 `security` 作为命令上下文的 `input` 传给 handler。没有 `argumentHint` 的命令可直接执行。

handler 可返回字符串或以下 JSON-safe 结果：

```ts
{
  message?: string;
  promptText?: string;
  submit?: boolean;
  panelId?: string;
  settingsPage?: 'general' | 'tools' | 'harness' | 'subagents' | 'permissions' | 'models'
    | 'mcp' | 'skills' | 'extensions' | 'about';
  action?: ExtensionUiAction;
}
```

返回值会再次清洗。`panelId` 必须指向同一扩展自己声明、已启用且有 `ui.panels` 权限的面板。renderer 不能扩大扩展权限。

composer contribution 是对命令的另一个入口；若它引用同一 command ID，输入菜单会按完整 command ID 去重，不会出现两个相同命令。

## 7. UI content

完整 UI 语义、布局、图表、表格、实时数据源和作者检查清单见 [Pi Studio Extension UI 规范](./extension-ui.md)。

UI content 是纯数据，最多 64 个 block。受支持 block：

| kind | 字段 |
| --- | --- |
| `heading` | `text`, 可选 `level: 2 \| 3` |
| `text` | `text` |
| `list` | `items[{ title?, text }]` |
| `keyValue` | `items[{ label, value }]` |
| `notice` | `tone`, 可选 `title`, `text` |
| `actions` | `buttons[{ id, label, tone?, action }]` |
| `badge` | `label`, 可选 `tone` |
| `emptyState` | `title`, 可选 `text`, `action` |
| `section` | 可选标题与说明，`content` |
| `stack` / `grid` | 组合内容；grid 支持 1–4 列 |
| `tabs` | 页内语义切换 |
| `disclosure` | 可折叠详情 |
| `metric` / `metricGrid` | 指标卡和指标集合 |
| `sparkline` / `chart` | 小型和多序列趋势 |
| `timeline` / `statusList` | 任务、服务和步骤状态 |
| `table` / `progress` | 紧凑表格和进度 |
| `dataView` | 受控实时数据源，支持加载、错误和回退内容 |
| `divider` | 无 |

notice tone：`info`、`success`、`warning`、`error`。

button tone：`default`、`primary`、`danger`。

禁止：

- HTML、SVG、CSS 或 style 字符串。
- `dangerouslySetInnerHTML` 或组件源码。
- 任意脚本、事件名或 Electron IPC 通道。
- renderer 专用 import。
- 未清洗的 URL。

内容只会映射到 Pi Studio 的统一组件和全局设计令牌，扩展不能绕过尺寸、颜色、圆角和可访问性规则。UI 规范还定义了实时订阅的节流、引用清理、数量和嵌套上限。

## 8. UI slots

| slot | 用途与约束 |
| --- | --- |
| `workspace.sidebar` | 侧边栏内的工作区相关短内容；必须适应窄宽度 |
| `conversation.header` | 会话顶部的单行摘要；使用 `text`、`badge`、`keyValue` 或紧凑实时数据 |
| `conversation.detail` | 会话扩展标签页中的完整详情卡；展示指标、表格、时间线和说明 |
| `conversation.footer` | 输入框附近的单行摘要；最多两个紧凑 block，不承载完整详情 |
| `composer.before` | 输入框上方，用于上下文提示或待办摘要 |
| `settings.panel` | 设置页内容；适合说明、状态和命令，不替代完整表单 |
| `panel.side` | 右侧工具面板中的摘要；不创建新导航体系 |
| `status.bar` | 底部状态栏；只放短文本和简单动作 |

扩展不能指定像素、绝对定位、z-index、动画或覆盖层。同一扩展可以同时声明 `conversation.detail` 与 `conversation.footer`：前者负责完整、清晰的页面卡片，后者只保留用户执行任务时需要持续看到的一行状态。Studio 会按稳定扩展 ID 把同一扩展的视图归组，使全局排序和会话级排序一起移动。

`conversation.footer` 最多允许两个 block，且只接受 `text`、`badge`、`keyValue`、`notice`、`dataView`。`heading`、`list`、`section`、`metricGrid`、`table` 以及操作按钮都会被拒绝。Footer 固定单行且不纵向滚动，由宿主省略超出内容；扩展应将完整数据和操作放入 `conversation.detail`。

`priority` 决定不同扩展在同一 slot 中的排序；相同优先级按 manifest 声明顺序排序。会话扩展中心允许用户覆盖全局顺序，也可以为单个会话保存独立顺序。`compact` 与 `regular` 只影响 Studio 提供的布局上限，不是任意尺寸声明。

未知 slot、未知 contribution 或非法 UI content 会让该 manifest 在扫描阶段失败，并在设置页报告精确诊断。已经运行的其他扩展不受影响，应用也不会因此崩溃。

## 9. UI actions

唯一允许的动作：

```ts
type ExtensionUiAction =
  | { kind: 'openSettings'; panel?: SettingsPage }
  | { kind: 'openPanel'; panelId: string }
  | { kind: 'sendPrompt'; text: string; submit?: boolean }
  | { kind: 'copyText'; text: string }
  | { kind: 'openUrl'; url: string }
  | { kind: 'runCommand'; commandId: string };
```

约束：

- `openUrl` 只接受 `http://` 或 `https://`。
- `sendPrompt` 只填充或提交输入框，不能伪造 assistant 消息。
- `runCommand` 必须指向同一扩展中带 runtime handler 的命令，并要求 `ui.commands` 权限。
- `openPanel` 必须指向同一扩展中声明的 panel，并要求 `ui.panels` 权限。
- UI 不能直接读写文件、数据库、凭据或任意 IPC。需要这些能力时由 Agent extension/tool 完成。

## 10. Scope、信任与来源

内置扩展由 Studio 安装，默认启用并信任。用户扩展和项目扩展仍使用同一套 manifest 与能力校验。

| scope | 默认信任 | 可见范围 | 持久化 |
| --- | --- | --- | --- |
| `builtin` | 是 | 所有工作区 | Studio SQLite |
| `user` | 是 | 所有工作区 | Studio 用户目录 |
| `project` | 否 | 当前工作区 | `<workspace>/.pi-studio` |

项目扩展导入后必须在设置页手动信任。即使用户只安装了声明式 UI 扩展，也要完成这一步，因为项目目录可能来自 Git 仓库。

设置页应始终展示：

- 扩展来源：builtin、user 或 project。
- manifest ID、版本和真实路径。
- 声明的权限与贡献数量。
- 启用、信任、可用和错误状态。
- 工具、命令、面板贡献的完整来源。

扩展被删除后，其贡献和命令立即消失；历史消息中已经产生的工具调用和结果仍作为历史事实显示。以后安装同 ID 扩展不能追溯性改变历史数据。

## 11. 热加载与运行中语义

安装、启停、信任、卸载和 manifest 文件刷新会重建 Durable registry。设置页保存后不需要退出应用。

生效边界遵循 Durable：

- 下一条模型请求使用新的 sections、tools 和模型工具列表。
- 已经开始的工具调用继续使用它开始时取得的实现。
- 当前 task phase 使用该 phase 开始时解析到的 hook 和 agent。
- Studio 工具权限在每次 `ToolTask` 前重新读取 SQLite，因此模式、会话覆盖和已记住的批准无需重建 Harness。
- 正在流式输出的消息不会因为扩展刷新被重写。
- Durable 运行策略通过同步 getter 在每次执行边界读取；超时、重试、上下文压缩和工具并行设置不需要重开 Harness。

`toolExecution: "parallel"` 只表示同一模型轮次中的独立工具会并发启动。依赖前一步结果的调用应留在后续轮次；实现仍可把具体工具标记为 `executionMode: "sequential"`，此时同一轮会按顺序执行。

因此设置页只能提示“下一请求生效”，不能宣称正在生成的请求会立即改变工具集合。

## 12. Agent extension 与 UI extension 的关系

Agent extension 不可以通过 `ctx.ui` 或 TUI 字符串自行生成界面。若 Agent 能力需要界面：

1. 在 manifest 中声明 UI contribution。
2. 在 command handler 中返回 JSON-safe 结果。
3. 或让 UI action 触发一个受控 command。

renderer 不直接调用 Agent 代码。主进程负责参数校验、权限检查、结果清洗和错误边界。

## 13. 与 MCP、Skills 的区别

| 类型 | 运行方式 | 最适合 |
| --- | --- | --- |
| MCP server | 独立 stdio/HTTP 服务 | 外部工具、内嵌资源和跨应用集成 |
| Skill | Markdown 指令包 | 可复用工作方法、领域知识 |
| Agent extension | 主进程 Node + Durable registry | 新工具、hooks、tasks、动态 prompt section |
| UI extension | 清单中的 JSON DTO | 状态、说明、动作入口和安全面板 |

MCP、Skill 与扩展都显示各自来源。卸载 MCP 或 Skill 不自动删除扩展，反之亦然。

### MCP 的存储与加载

MCP server、启用状态、exposure、逐工具覆盖、超时、stdio 工作目录和 HTTP headers 保存在 Studio SQLite 的 `mcp_servers` 表。`env` 与 `headers` 值使用 Electron `safeStorage` envelope 加密；renderer 只收到键名，永远收不到值。连接状态、工具目录和错误只存在于当前进程，不写回配置。

Studio 的 MCP 连接按应用共享，因此 stdio `cwd` 只接受绝对路径或以 `~/` 开头的路径。未配置时使用 Studio userData 目录，而不是打包后不可预期的 Electron `process.cwd()`。`command`、`args` 和 `cwd` 支持 `~/`；env/header 值支持 `${ENV_NAME}`。Studio 有意不执行 `!command`。stdio 子进程只继承 `PATH`、`HOME`、临时目录、locale 和系统启动所需的少量环境变量，不会自动继承 shell 中其他密钥；需要时必须在 server 配置里显式使用 `${NAME}`。远程 HTTP endpoint 必须是 HTTPS，只有 `localhost`、`127.0.0.1` 和 `::1` 可使用 HTTP 开发。

Studio 当前没有 codemode，因此默认使用 Pi Durable 的 `deferred + tool_search`。模型先看到 server namespace 与摘要，通过 `tool_search` 加载具体工具；加载结果从下一模型请求开始可用，并写入该会话分支的 `modelTools`，后续轮次和分支继续可见。`direct` 工具直接进入请求，`hidden` 工具只允许其他工具经 `executeTool()` 调用。每个 MCP 工具仍受 Studio 智能体工具白名单约束，支持 `mcp__*` 和 `mcp__server__*`。

MCP 配置保存后立即重连或重建 registry；活动中的模型请求和已经开始的工具调用不会被改写。需要替换连接时，旧 client 进入退休态，等它的活动工具调用结束后再关闭。server 发出 `tools/list_changed` 后只刷新该 server 的目录，下一请求看到新工具。文本超过 20KB 时保留首尾并保存完整临时文件；图片内容继续作为图片传给模型。

当前边界：

- stdio 与 Streamable HTTP 已支持；legacy SSE 不支持。
- HTTP 使用静态 headers；MCP OAuth 登录流程尚未接入。
- 工具结果中的文本、图片、内嵌文本/图片资源和 resource link 会转换；独立的 MCP resources/templates 列表与读取工具尚未注册。
- prompts、sampling、tasks 和 MCP Apps UI 尚未暴露。

### Skill 的存储与加载

| scope | 发现位置 | SQLite |
| --- | --- | --- |
| user | `<Studio userData>/skills/<skill>/SKILL.md`；通用 `<home>/.agents/skills/<skill>/SKILL.md` | 不保存正文 |
| project | `<workspace>/.pi-studio/skills/<skill>/SKILL.md`；通用 `<workspace>/.agents/skills/<skill>/SKILL.md` | `project_resource_trust` 保存项目技能信任与内容指纹 |

Studio 只发现 Agent Skills 标准目录形式的 `SKILL.md`，递归扫描时遇到含 `SKILL.md` 的目录便停止。Studio 私有目录用于“添加技能”的导入目标；`.agents/skills` 是跨客户端互操作目录，只被发现，不会被 Studio 自动改写。优先级固定为 Studio 项目技能、通用项目技能、Studio 用户技能、通用用户技能，冲突会写入诊断。

系统提示只注入 `name`、`description` 和绝对 location，正文由模型的 `read` 工具按需加载；如果本次没有 `read`，则允许 `bash` 读取，两者都未开放时不会注入自动 Skill 提示。模型根据 description 自行判断是否加载，不能保证每个任务都会调用；`/skill:name` 是确定性的显式加载方式。`disable-model-invocation: true` 只隐藏自动提示，显式命令仍会由主进程展开。

frontmatter 使用 Pi 同款 YAML parser。`name`、`description`、`compatibility`、`metadata` 和实验性的 `allowed-tools` 会按 Agent Skills 约束检查；名称或目录不匹配等问题作为诊断保留，缺失 description 或无法解析 YAML 会跳过该技能。Studio 当前读取但不强制 `allowed-tools`，因为该字段仍属实验性能力，工具权限继续由 Studio 智能体工具白名单控制。

项目 Skill 默认不信任。信任指纹覆盖整个技能目录，包括隐藏文件；符号链接目标必须仍位于技能目录或工作区内。任何文件、权限或链接变化都会使旧信任失效。首次计算后使用文件元数据签名判断是否需要重新读取内容，正常文件修改仍会触发完整内容哈希。导入项目 Skill 时会在复制前验证源目录，复制后再验证目标目录，失败不会留下半成品。

Skill 不需要热重载命令。Durable 在每次模型请求前重新渲染 section，因此新增、删除或修改用户 Skill 会在同一 run 的下一工具回合可见；显式 `/skill:name` 会在提交前立即展开。已经进入 transcript 的正文不会因磁盘后续修改而被追溯改写。Studio 不读取 `~/.pi` 或 Pi CLI 的 skill settings，只额外遵循公开的 `.agents/skills` 互操作约定。

## 14. 安全边界

Studio 会执行以下防护：

- manifest 字段、长度、枚举、权限和贡献 ID 白名单校验。
- 扩展入口 realpath containment。
- 导入目录和符号链接越界检查。
- UI content 和 action 递归清洗。
- MCP env/header 使用 `safeStorage` envelope，renderer DTO 只含键名。
- 项目 Skill 使用整目录指纹，越界符号链接不进入可用列表。
- renderer 只收到 JSON-safe DTO。
- 项目扩展默认不信任。
- manifest、声明式 UI、action 和实时数据中的未知字段会在各自边界直接拒绝，并给出带路径的定位信息；不会静默忽略后继续执行。

这些措施不能替代代码审计。`agent.*` 扩展拥有 Node 权限，`network` 也不能阻止它访问网络。真正的隔离需要独立进程或操作系统沙箱。

扩展不得读取或修改 `~/.pi` 兼容配置。Studio 的模型、凭据、会话投影、MCP、Skill 和扩展状态均属于 Studio 自己的 SQLite 或受管目录。

## 15. 扩展作者检查清单

- 使用 `format: 1`，ID 和版本稳定。
- 只声明实际使用的权限。
- 所有 Agent capability 都由 `runtime.durableEntry` 提供。
- command handler 与 manifest 声明一一对应。
- UI 只用受支持 content block 和 action。
- 不依赖 slot 的具体尺寸、颜色或位置。
- 不在 Agent extension 中假设 Studio renderer API。
- 不把 HTML、脚本或任意 IPC 塞进 UI 数据。
- 项目扩展清楚说明权限和信任要求。
- 运行成功、错误、禁用、未信任和卸载场景。
- 用真实 Durable child conversation 测试子智能体/任务相关工具。

## 16. 兼容与演进

`apiVersion` 由 Studio 当前 extension host 返回。`manifest.format` 描述清单协议，扩展自身的 `version` 描述发布版本。

`format: 1` 采用封闭契约。新增或改变 manifest、contribution、action、content block 或实时数据字段时，不能假设旧版宿主会安全忽略；需要通过 `engines.piStudio` 限制兼容版本，并提升受影响协议的 `format` 或提供显式能力协商。删除字段、改变字段含义、放宽或收紧关键权限时，同样必须提升 format 并提供迁移说明。

renderer 使用稳定 DTO，而不是直接依赖 Studio 内部 service。未来的新 slot、新 action 或新 content block 应先扩展类型和主进程清洗逻辑，再接入 UI；不得让任意扩展绕过契约直接注册 React 组件。
