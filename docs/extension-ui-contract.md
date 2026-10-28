# Pi 扩展 UI 契约

Pi Studio 不按扩展名写界面。扩展只使用 Pi 标准的 `ctx.ui` API，桌面端负责把每个原语放到固定槽位并统一渲染。**同一份扩展代码，在 `pi` 终端与 Pi Studio 中都能用。**

## 规则

1. **只通过 `ctx.ui` 暴露 UI。** 不直接写 stdout、ANSI 转义或终端控制序列。
2. **Pi Studio 绑定 `mode: 'tui'`，因此必须实现完整的 `ExtensionUIContext`。** 新的原语只实现一次，所有扩展共享；禁止按扩展名做判断。
3. **每个原语对应固定槽位。**
4. **位置偏好只能用 API 自带参数表达。** `setWidget` 用 `placement`，`custom` 用 `overlay`；其余由 Pi Studio 决定宽度、层级和样式。
5. **富交互用 pi-tui `Component`。** 实现 `render(width)`，需要交互时实现 `handleInput` / `handleMouse`；终端与桌面共用。
6. **组件不得假设终端尺寸。** 使用传入的 `tui.terminal.columns` / `rows`，并响应 `requestRender`。
7. **必须有纯文本降级。** `hasUI === false`、`mode !== 'tui'` 或组件渲染异常时退回 `notify` / 文本，不能崩会话。
8. **Pi Studio 不解析扩展业务语义。** 不判断“权限模式 / todo / 额度”；只做槽位、渲染和事件转发。

## 槽位映射

| `ctx.ui` 原语 | Pi Studio 槽位 | 状态 |
|---|---|---|
| `notify` | 右上角 toast | 已实现 |
| `setStatus` | 统一状态栏 chip（可排序 / 显隐） | 已实现 |
| `setWidget(aboveEditor)` | 输入框上方 | 已实现（字符串 / Component） |
| `setWidget(belowEditor)` | 输入框下方 | 已实现（字符串 / Component） |
| `setFooter` | 统一状态栏的紧凑运行指标（点击展开完整明细） | 已实现 |
| `custom({ overlay: true })` | 应用内浮层 | 已实现（键盘 / 鼠标 / done） |
| `custom({ overlay: false })` | 右侧面板 | 已实现 |
| `select` | 统一选择对话框 | 已实现 |
| `confirm` | 风险确认卡片 | 已实现 |
| `input` / `editor` | 统一输入对话框 | 已实现 |
| `onTerminalInput` | 当前聚焦扩展浮层 / 面板的键盘 | 已实现（仅 custom 焦点） |
| `setTitle` | 窗口标题 | 已实现 |
| `setWorkingMessage/Visible/Indicator` | 输入框上方工作状态 | 已实现（Indicator 仅支持显隐） |
| `setHeader` | 对话内容上方 | 已实现 |
| `pasteToEditor` / `setEditorText` / `getEditorText` | 输入框 | 已实现 |
| `setEditorComponent` / `addAutocompleteProvider` | 输入框替换 | 待实现（复杂原语） |
| `theme` 相关 | 应用主题映射 | 部分实现 |

## 统一状态栏

`setStatus` 与 `setFooter` 不再各占一行，而是合并到输入框下方的 Status Dock：

- footer 只显示第一段（轮次 / 步数 / 速率），点击展开 token、缓存、上下文等完整指标；
- 状态 chip 默认按 key 稳定排序，点击查看完整文本；
- 右侧「管理」可调整顺序、显示 / 隐藏，配置保存在本机 `localStorage`；
- 重复的状态不会再单独占一行（footer 明细只在弹层中出现）。

### 指标来源

- `20 轮 218 步 · 130 tok/s` 来自 `pi-footer-composer` 的 `setFooter`；
- `llm: 40m43s · tools: 28m12s · ttft … · e2e …` 来自 `pi-throughput` 的 `setStatus`。

两者语义相近但来源不同，不是同一条数据；可以在「管理」里隐藏其中任意一个。

## 已知限制

- custom 组件的 `keybindings.matches()` 覆盖 Pi TUI 常用动作（`tui.select.*`、`tui.input.*`、部分 `tui.editor.*`）；扩展自定义键位暂不生效。
- `setEditorComponent`、`addAutocompleteProvider` 尚未接入桌面端。
- `setWorkingIndicator` 目前只处理显隐，不支持自定义动画帧。
- `custom` 的 `overlayOptions` 支持 `width` / `maxHeight`；`anchor`、`offset`、`margin` 仍由桌面端布局决定。

## 写扩展时的检查清单

- 是否只用了 `ctx.ui`，没有平台判断（不判断 `process.env` 或应用名）？
- 富 UI 是否写成 pi-tui Component，而不是桌面端专用 HTML/JSON？
- 是否处理了 `hasUI === false` 或渲染失败？
- widget 是否只用 `placement` 表达上下位置？
- `custom` 是否在完成时调用 `done(result)`？
- 是否能在终端里运行同一份代码？

## 测试

`examples/pi-ui-contract-extension/` 是一个只依赖标准 API 的示例：

```bash
ln -s "$PWD/examples/pi-ui-contract-extension" ~/.pi/agent/extensions/pi-ui-contract
pi            # 终端里执行 /ui-contract
# 或在 Pi Studio 里打开会话，输入 /ui-contract
```

如果示例在两端表现一致，说明契约没有被 Pi Studio 特判污染。
