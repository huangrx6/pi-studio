# Pi Studio Extension UI 规范

Pi Studio 的扩展 UI 是 **JSON 数据**，不是网页。扩展声明内容、语义和受控动作，Studio 负责布局、颜色、字号、圆角、间距、动画、可访问性和响应式行为。

这套约束让扩展在不同主题、背景图片、侧栏宽度和系统辅助功能下保持一致，也避免第三方内容绕过全局设计系统。

## 1. 基本原则

扩展只能提交以下数据：

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

侧栏和紧凑 slot 会自动把 `grid` 与 `metricGrid` 收敛为一列，扩展不需要判断窗口宽度。

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

## 3. 会话摘要与完整详情

`conversation.footer` 只负责一行实时摘要。它最多接受两个 block，并且只允许 `text`、`badge`、`keyValue`、`notice`、`dataView`；完整布局和操作按钮会被 manifest 校验拒绝。Footer 不换行、不纵向滚动，超出宽度时由 Studio 省略。

```json
{
  "id": "quota-summary",
  "title": "额度摘要",
  "slot": "conversation.footer",
  "size": "compact",
  "content": [
    {
      "kind": "text",
      "text": "5H 1% · W 11% · GLM"
    }
  ]
}
```

完整数据使用独立的 `conversation.detail` 面板。它可以组合指标、表格、图表、状态列表和操作，以便用户看清来源、时间、额度窗口和异常说明。

```json
{
  "id": "quota-detail",
  "title": "额度状态",
  "slot": "conversation.detail",
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

同一个扩展可以同时声明 summary 与 detail。会话内始终渲染摘要；扩展标签页展示详情。用户排序时两者按扩展 ID 一起移动，扩展内部仍按 manifest 的 `sourceOrder` 保持声明顺序。

## 4. 组合示例

下面的面板同时使用指标、tabs、时间线和表格：

```json
{
  "id": "runtime",
  "title": "运行概览",
  "slot": "panel.side",
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
- `openPanel` 只能打开当前扩展自己声明、当前仍然可用的完整 panel ID，并要求 `ui.panels` 权限。
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
- 面板在侧栏、右栏、明暗主题和窄窗口中都能正常阅读。
- 实时数据有加载、空、错误和清理路径。
- 危险按钮使用 `danger`，主要操作只使用一个 `primary`。
- 一个 `actions` 分组只保留一个 `primary`；其余操作用 `default`，必要时降级为 `danger`。
- 大表格和长内容放入 `disclosure` 或独立 panel，避免撑高输入区。
- 用 `description` 解释数据来源和时间含义。
