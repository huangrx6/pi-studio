# Pi Studio Extension UI 规范

扩展 UI 使用 JSON 声明式数据，由 Studio 负责布局、主题与可访问性。实时画布或任务看板等交互界面可在 `tool.view` 声明 `view`，在悬浮工具面板的受控沙箱 iframe 中加载插件自身的 `ui/` 静态资源。

这套约束让扩展在不同主题、背景图片、窗口宽度和系统辅助功能下保持一致，也避免第三方内容绕过全局设计系统。

## 1. 基本原则

普通声明式扩展只能提交以下数据：

- 文本和结构化数据。
- 语义 block，例如指标、表格、进度、时间线和 tabs。
- `compact`、`regular` 等尺寸档位。
- `neutral`、`info`、`success`、`warning`、`error` 等语义色调。
- 白名单 UI action。

扩展不能提交：

- HTML、React 组件、SVG 源码或 JavaScript。
- CSS class、style 对象、颜色、像素、字体、阴影或动画。
- 绝对定位、层级、浮层或覆盖整个页面的元素。
- Electron IPC、文件系统、数据库或凭据访问。
- 任意 URL scheme、脚本 URL 或未清洗的 markdown HTML。

颜色必须来自 Studio 全局 palette tokens。页面背景保持中性，强调色只用于小面积状态和操作。

## 2. Block 目录

### 内容

| kind | 用途 | 主要字段 |
| --- | --- | --- |
| `heading` | 分区标题 | `text`, `level: 2 \| 3` |
| `text` | 正文 | `text` |
| `list` | 简短条目 | `items[{ title?, text }]` |
| `keyValue` | 键值详情 | `items[{ label, value }]` |
| `badge` | 状态标签 | `label`, `tone?` |
| `notice` | 提示或诊断 | `title?`, `text`, `tone` |
| `emptyState` | 空状态 | `title`, `text?`, `action?` |
| `divider` | 分组分隔 | 无 |

### 布局

| kind | 用途 | 主要字段 |
| --- | --- | --- |
| `section` | 有边界的语义分组 | `title?`, `description?`, `tone?`, `density?`, `content` |
| `stack` | 纵向内容组 | `gap?`, `content` |
| `grid` | 响应式网格 | `columns: 1–4`, `density?`, `content` |
| `tabs` | 页内切换 | `tabs[{ id, label, content }]`, `activeTab?` |
| `disclosure` | 可折叠详情 | `title`, `description?`, `open?`, `content` |

窄窗口和紧凑 slot 会自动把 `grid` 与 `metricGrid` 收敛为一列，扩展不需要判断窗口宽度。

### 数据可视化

| kind | 用途 | 主要字段 |
| --- | --- | --- |
| `metric` | 单个指标 | `id`, `label`, `value`, `unit?`, `detail?`, `trend?`, `tone?` |
| `metricGrid` | 指标卡集合 | `columns: 1–4`, `metrics[]` |
| `sparkline` | 小型趋势 | `label`, `values[]`, `unit?`, `tone?` |
| `chart` | 多序列趋势 | `title`, `series[]`, `labels?`, `unit?` |
| `timeline` | 带状态的时间线 | `items[{ id, title, detail?, time?, status? }]` |
| `statusList` | 服务或步骤状态 | `items[{ id, label, detail?, status? }]` |
| `table` | 紧凑表格 | `columns[]`, `rows[]` |
| `progress` | 进度和额度 | `label`, `value`, `max?`, `detail?`, `tone?` |

`status`：`pending`、`active`、`success`、`warning`、`error`、`neutral`。

数值数组最多 256 点，表格最多 12 列、200 行；超出限制的 manifest 或实时更新会被拒绝。

### 操作

`actions` 包含最多 12 个按钮：

```json
{
  "kind": "actions",
  "buttons": [
    {
      "id": "open-details",
      "label": "查看详情",
      "tone": "primary",
      "action": {
        "kind": "openPanel",
        "panelId": "detail"
      }
    }
  ]
}
```

按钮只能使用 `default`、`primary`、`danger` 三种语义 tone。
同一组 `actions` 最多只能声明一个 `primary`。Studio 会在 manifest 和实时数据进入渲染层之前拒绝多个主操作，避免页面出现竞争性视觉焦点。

## 3. 会话摘要和详情面板

`status.chip`、`composer.above`、`composer.below` 使用单行摘要。每项最多允许两个区块，支持 `text`、`badge`、`keyValue`、`notice`、`dataView`。

悬浮工具面板承载 `tool.view`，状态栏弹出层承载 `status.detail`。摘要可通过 `details` 打开同一扩展的任一详情视图。

`visibility` 默认为 `always`。声明 `while-active` 时只在当前回合执行中显示摘要，详情始终可以打开。额度状态卡片按当前会话的模型来源读取用户选中的额度字段。内置 Studio 指标卡片在生成时显示实时速率，回合结束后显示最近请求的读数。

摘要可用 `slot` 声明一个位置，或用 `slots` 声明用户可选择的位置。用户在扩展设置的「界面显示」中为每条摘要选择一个位置，也可以隐藏摘要。其详情面板仍可从「扩展」打开。

```json
{
  "id": "metrics-chip",
  "title": "实时指标",
  "slots": ["status.chip", "composer.above", "composer.below"],
  "icon": "activity",
  "color": "info",
  "size": "compact",
  "details": "metrics-detail",
  "visibility": "while-active",
  "content": [{ "kind": "dataView", "sourceId": "user:example.metrics/summary" }]
}
```

包含 `status.chip` 的摘要必须声明 `details`，默认显示在底部状态栏。用户可以隐藏摘要，或切换到扩展同时声明的输入框位置。仅声明输入框位置时使用第一个已声明的位置。

### 给视图和摘要设置图标与配色

应用入口优先使用所属插件清单 `icon` 指向的包内 PNG，其次使用视图声明的 `icon` 和 `color`。摘要使用自身的外观声明。

| 字段 | 可选值 | 缺省行为 |
| --- | --- | --- |
| `icon` | `activity`、`gauge`、`timer`、`terminal`、`chart`、`wallet`、`database`、`cloud`、`cpu`、`layers`、`plug`、`zap` | 视图默认使用插头，摘要默认使用波形 |
| `color` | `neutral`、`accent`、`info`、`success`、`warning`、`error` | 缺省为 `neutral`，颜色随主题切换 |

在「设置 → 插件 → 扩展」中点击卡片或列表项，即可打开扩展设置。「界面显示」按视图和对话摘要列出各项，可分别调整图标与配色，或为摘要选择显示位置。插件图标保留原配色，选用内置图标时可以调整主题配色。「恢复默认」会清除图标和配色覆盖，恢复插件图标或面板声明的外观。

```json
[
  {
    "id": "quota-chip",
    "title": "额度状态",
    "slot": "status.chip",
    "icon": "gauge",
    "size": "compact",
    "priority": 20,
    "details": "quota-detail",
    "content": [
      { "kind": "text", "text": "5H 1% · W 11%" }
    ]
  },
  {
    "id": "quota-detail",
    "title": "额度状态",
    "slot": "status.detail",
    "icon": "gauge",
    "color": "info",
    "size": "regular",
    "content": [{ "kind": "text", "text": "完整内容" }]
  }
]
```

`details` 使用同一份清单中的视图 ID。实际模型额度在「设置 → 模型配置」中按来源配置。项目脚本示例通过摘要打开工具面板中的脚本命令表。[项目脚本速查](../../extensions/pi-project-scripts/README.md)

```json
{
  "id": "quota-summary",
  "title": "额度摘要",
  "slot": "composer.below",
  "size": "compact",
  "content": [
    {
      "kind": "text",
      "text": "5H 1% · W 11% · GLM"
    }
  ]
}
```

状态栏详情可组合指标、表格、图表和操作，展示来源、更新时间、额度窗口和异常说明。

```json
{
  "id": "quota-detail",
  "title": "额度状态",
  "slot": "status.detail",
  "size": "regular",
  "content": [
    {
      "kind": "metricGrid",
      "columns": 2,
      "metrics": [
        { "id": "five-hour", "label": "5 小时", "value": 1, "unit": "%" },
        { "id": "weekly", "label": "本周", "value": 11, "unit": "%" }
      ]
    },
    {
      "kind": "keyValue",
      "items": [
        { "label": "来源", "value": "GLM Coding Plan" },
        { "label": "更新", "value": "12:00:00" }
      ]
    }
  ]
}
```

扩展设置由 `contributes.settings` 声明，使用 `ui.settings` 权限，在该扩展的设置中显示。

## 4. 组合示例

下面的面板同时使用指标、tabs、时间线和表格：

```json
{
  "id": "runtime",
  "title": "运行概览",
  "slot": "tool.view",
  "size": "regular",
  "content": [
    {
      "kind": "metricGrid",
      "columns": 2,
      "metrics": [
        {
          "id": "tps",
          "label": "输出速度",
          "value": 42.8,
          "unit": "tok/s",
          "trend": { "direction": "up", "label": "8%", "tone": "positive" }
        },
        {
          "id": "ttft",
          "label": "首字延迟",
          "value": 612,
          "unit": "ms"
        }
      ]
    },
    {
      "kind": "tabs",
      "activeTab": "now",
      "tabs": [
        {
          "id": "now",
          "label": "当前",
          "content": [
            {
              "kind": "statusList",
              "items": [
                { "id": "model", "label": "模型请求", "status": "active" },
                { "id": "tools", "label": "工具调用", "detail": "2 个并行任务", "status": "pending" }
              ]
            }
          ]
        },
        {
          "id": "trace",
          "label": "轨迹",
          "content": [
            {
              "kind": "timeline",
              "items": [
                { "id": "submit", "title": "提交请求", "time": "12:01:02", "status": "success" },
                { "id": "stream", "title": "流式输出", "time": "12:01:03", "status": "active" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

## 5. 实时数据

### 受控沙箱视图（`panel.view`）

需要独立交互界面的插件（例如官方的 `studio.excalidraw` 与 `studio.task-board`），可在 `tool.view` 声明 `view`，把前端界面完全打包在插件自身的 `ui/` 目录内，与 Pi Studio 宿主彻底解耦：

```json
{
  "id": "board",
  "title": "我的面板",
  "slot": "tool.view",
  "view": {
    "entry": "ui/index.html",
    "sourceId": "board-data",
    "scope": "global"
  }
}
```

- `entry`：必须指向扩展包 `ui/` 目录内的相对 HTML 路径（如 `ui/index.html`），通过只读协议 `pi-ext://view/<scope>/<manifestId>/...` 加载，并附带严格 CSP 与 `iframe sandbox="allow-scripts allow-downloads"`。
- `sourceId`：同一扩展声明的数据源 ID，需同时具备 `ui.panels` 与 `ui.data` 权限，且该面板 `content` 留空。
- `scope`：`"session"`（默认，随工作区与会话切换）或 `"global"`（跨工作区与会话共享，需用户级安装）。
- 数据源可返回 `{ viewData: <JSON-safe payload> }`（并在 `context.viewParams` 中接收前端通过 `view:query` 传来的筛选条件），并实现 `invoke(context, method, params)` 处理前端 `view:invoke` RPC 请求。状态栏弹窗中的视图可在按下 Escape 时发送 `view:close`，由宿主关闭弹窗并把焦点还给入口。
- 紧凑状态栏弹窗可发送 `{ type: 'view:resize', height }` 报告内容高度。宿主按窗口可用空间限制高度，展开和收起使用状态栏的统一动效。
- 沙箱视图与宿主通过 `pi-studio:ext-view:v1` `postMessage` 协议通信，支持读取宿主主题与设计变量（`host:context`）、订阅快照（`host:snapshot`）、触发提示（`view:notify`）、填入当前会话（`view:sendPrompt`）以及打开临时会话（`view:openTemporaryChat`）。宿主上下文和数据源接口分别见 [视图 SDK 声明](../../sdk/extensions/view-theme.d.mts)和[扩展 SDK 声明](../../sdk/extensions/types/pi-studio-extension-authoring.d.ts)。

### 在插件中跟随 Studio 外观

声明式面板由 Studio 自动配色。独立 HTML 视图可以把 SDK 的 `view-theme.mjs` 复制到插件的 `ui/` 目录，或随前端一起打包。注册消息监听后发送 `view:ready`。首次连接、切换亮暗模式、强调色或圆角时，宿主会发送当前的 `theme`（`light` 或 `dark`）和已解析的 CSS 变量。主窗口和独立工具面板使用同一份协议。完整变量表和应用函数见 [主题 SDK](../../sdk/extensions/view-theme.mjs)。

```js
import { applyStudioTheme } from './view-theme.mjs';

const protocol = 'pi-studio:ext-view:v1';
window.addEventListener('message', ({ source, data }) => {
  if (source === window.parent && data?.protocol === protocol && data.type === 'host:context') {
    applyStudioTheme(data);
  }
});
window.parent.postMessage({ protocol, type: 'view:ready' }, '*');
```

| 界面用途 | CSS 变量 |
| --- | --- |
| 文档、画布和列表底色 | `--surface-canvas` |
| 侧栏和工具栏 | `--surface-chrome` |
| 卡片、输入框 | `--surface-raised`、`--composer-surface` |
| 菜单、弹窗和遮罩 | `--surface-floating`、`--dialog-surface`、`--scrim`、`--shadow-float` |
| 正文、说明和边界 | `--text`、`--muted`、`--border`、`--divider` |
| 悬停、当前项、键盘焦点 | `--surface-hover`、`--nav-selected-bg`、`--focus-color` |
| 强调色、主按钮 | `--accent`、`--button-bg`、`--on-button` |
| 状态反馈 | `--info`、`--success`、`--warning`、`--error`，各有 `-soft` 底色和 `-border` 边框 |

```css
body { background: var(--surface-canvas, var(--bg, Canvas)); color: var(--text, CanvasText); }
.sidebar { background: var(--surface-chrome, var(--surface)); }
.card, input { background: var(--surface-raised, var(--surface)); border: 1px solid var(--border); }
dialog { background: var(--dialog-surface, var(--surface)); color: var(--text); }
```

默认主题使用内容底色和侧栏底色。卡片、输入框和浮层复用侧栏底色，边框和阴影区分边界。插件可以在自身容器上覆盖变量来实现用户选定的主题，切回「跟随 Studio」时移除这些覆盖即可。较早的宿主只提供 `--bg`、`--surface` 等基础角色，上例也适用于这些版本。

视图可以从 `host:context.tokens` 取宿主的字号。页面、弹窗和分组标题分别使用 `--text-title`、`--text-heading` 和 `--text-subtitle`。正文用 `--text-body`，按钮和表单用 `--text-label`，说明用 `--text-description`，时间与计数用 `--text-caption`，代码用 `--text-code`。完整定义见[全局排版变量](../../web/src/styles/typography.css)。

同一条消息也提供图标尺寸。按钮和工具栏用 `--icon-sm`，导航和列表用 `--icon-md`。将变量应用到 SVG 或图片的宽高，按钮本身保留独立的点击范围。详见[全局图标尺寸](../../web/src/styles/icon-sizes.css)。

静态面板适合说明和检查清单；指标、任务状态等短期数据使用 `dataView`。

```json
{
  "kind": "dataView",
  "sourceId": "builtin:studio-metrics/live",
  "emptyText": "还没有运行指标",
  "fallback": [
    { "kind": "text", "text": "正在连接 Metrics Runtime…" }
  ]
}
```

`sourceId` 必须是完整的 contribution ID。实时 view 只有可见且已挂载时才订阅；切换会话、关闭窗口、停用扩展、重载扩展或组件卸载时会自动执行 provider 的清理函数。

`fallback` 用于首次读取完成前的加载内容；provider 返回空内容时显示 `emptyText`；读取、权限或清理错误由 Studio 的统一错误状态展示，扩展不能自行绘制覆盖层。实时内容仍按完整 manifest 上限校验。

主进程 provider：

```js
export const dataSources = {
  live: {
    async read(context) {
      return metricsRuntime.snapshot(context.sessionId);
    },
    subscribe(context, publish) {
      return metricsRuntime.subscribe(context.sessionId, (snapshot) => {
        publish(snapshot.content);
      });
    },
  },
};
```

要求：

- `read()` 返回 `ExtensionContent[]`。
- `subscribe()` 返回同步或异步的清理函数。
- 更新内容仍要经过完整 block 校验。
- Host 会节流推送，并限制每个窗口与整个应用的订阅数。
- 实时数据不写入 transcript；需要跨重启保存的数据由扩展自己的受管数据目录负责。

## 6. UI action

```ts
type ExtensionUiAction =
  | { kind: 'openSettings'; panel?: SettingsPage }
  | { kind: 'openPanel'; panelId: string }
  | { kind: 'sendPrompt'; text: string; submit?: boolean }
  | { kind: 'copyText'; text: string }
  | { kind: 'openUrl'; url: string }
  | { kind: 'runCommand'; commandId: string };
```

- `openUrl` 只允许 `http` 和 `https`。
- `sendPrompt` 只填充或提交输入框。
- `openPanel` 需有 `ui.panels` 权限，目标为同一扩展声明且可用的 `tool.view` 或 `status.detail`。
- `runCommand` 只能调用当前扩展自己声明、由 runtime handler 提供实现的完整 command ID，并要求 `ui.commands` 权限。它不能转去执行另一个带静态 action 的命令，避免声明之间形成递归操作链。
- command handler 返回的 action、panel ID 和设置页会在执行前再次清洗。
- renderer 对动态 command 返回的 action 最多跟随 4 层；恶意或错误的循环会被中止并显示统一错误。
- renderer 不直接执行扩展代码。

## 6. 安全边界

Studio 对扩展内容的校验是递归的：

- 总 block 数最多 64。
- 嵌套层级最多 5。
- 每层只接受白名单字段。
- 文本、数组、表格、图表点数和订阅数量都有上限。
- 未知字段直接形成 manifest 或实时数据错误。
- 颜色、样式、定位、事件和任意组件字段都会被拒绝。

Agent extension 本身仍是受信任 Node 代码。UI 数据限制不能替代对可执行扩展来源的审计。

## 7. 发布清单

- 为每个 panel、setting、command 使用稳定 ID。
- 为内容选择语义 block，不模拟具体像素布局。
- 所有颜色由 Studio token 决定，不在文案或数据里携带 CSS。
- 视图在工具面板、明暗主题和窄窗口中均可阅读。
- 实时数据有加载、空、错误和清理路径。
- 危险按钮使用 `danger`，主要操作只使用一个 `primary`。
- 一个 `actions` 分组只保留一个 `primary`；其余操作用 `default`，必要时降级为 `danger`。
- 大表格和长内容放入 `disclosure` 或独立 panel，避免撑高输入区。
- 用 `description` 解释数据来源和时间含义。
