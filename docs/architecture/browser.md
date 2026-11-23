# 内嵌浏览器与 AI 浏览器操控

本文是 Pi Studio 右侧内嵌浏览器，以及后续「Agent 可在可见浏览器中阅读与操作网页」能力的正式设计。它描述产品边界、分层能力、主进程控制面、工具契约、权限模型与分阶段交付；实现细节以代码为准，本文只固定约定。

相关边界见 [能力模块与依赖边界](capabilities.md)、[会话内容展示规则](conversation-content.md) 与 [资源作用域](../guides/resources.md)。

## 1. 目标与非目标

### 1.1 产品定位

Pi Studio 的浏览器是**工程工作台浏览器**，不是通用个人浏览器，也不是独立的「浏览器 Agent 产品」。

典型场景：

- 打开 `localhost` 预览、文档站、API 控制台、登录后的内部工具；
- 在对话旁保留网页上下文，人工与 Agent 共用同一可见标签；
- 后续让 Agent 在受控权限下读取页面结构、截图，并对页面执行点击、输入等操作；
- 人可随时接管，且能看清 Agent 正在看什么、要做什么。

它与会话里「搜索/读取网页」工具互补：后者偏抓取与引用；本能力偏**可见、可交互、可接管的真实浏览会话**。

### 1.2 对标与取舍

| 参考 | 可借鉴 | 不照搬 |
| --- | --- | --- |
| ChatGPT 内嵌 / Browser Use 类能力 | 独立会话配置文件、按站点权限、Agent 可读可操作、人工可见与接管、可选标注与底层调试 | 完整消费级浏览器、默认系统 Cookie、无审批的任意操控 |
| 智谱等助手内嵌浏览器 | 侧栏多标签、地址栏与导航、和对话并排 | 重社交/资讯门户形态 |
| 桌面自动化 / CDP 工具链 | 结构化快照、动作语义、可回放的操作日志 | 默认开启完整 Chrome DevTools Protocol、静默接管用户日常 Chrome |

Studio 优先服务开发与项目交付，不把「替用户逛全网」当作默认目标。

### 1.2.1 设置与资料（已落地）

| 能力 | 约定 |
| --- | --- |
| 链接打开目标 | `webLinkOpenTarget` / `localLinkOpenTarget`：`workbench` 或 `system`；对话 Markdown 链接按此分流。 |
| 下载询问路径 | `askDownloadPath` 为真时，内嵌分区下载先弹出保存位置；默认仍写入 Studio 托管下载目录。 |
| 偏好热更新 | `setBrowserPreferences` 通过 `subscribeBrowserPreferences` 广播 `{ type: 'preferences' }`，工作台壳即时刷新（如完整网址）。 |
| 密码 | 主进程 `safeStorage` 信封；列表不含明文；仅显式「显示」IPC 可揭密；不向模型暴露。 |
| 联系信息 | 本机设置投影，便于查阅；当前不做网页自动填入。 |
| 扩展 | 仅加载已解压目录（`manifest.json`）；路径持久化并在启动时 best-effort 恢复；非扩展商店客户端。 |
| 外接 Chrome | 设置页发现/连接；工作台显示已外接会话条并可一键断开；`{ type: 'external', sessions }` 事件。 |

### 1.3 非目标（当前阶段明确不做）

- 成为默认系统浏览器，或同步系统 Chrome/Safari 的全部书签、扩展与 Cookie。
- 无审批的跨站登录、支付、下载可执行文件；不提供扩展商店一键安装（仅可选加载本机已解压扩展）。
- 扩展或模型注入任意 HTML/JS/CSS 到浏览器壳层（扩展 UI 仍走声明式数据）。
- 用扩展完整性摘要冒充操作系统级沙箱。
- 将完整 CDP 或外接 Chrome 作为**默认**路径（二者仅高级设置、默认关闭）。
- 多窗口浏览器产品形态。

## 2. 现状

| 层级 | 现状 |
| --- | --- |
| UI | `BrowserPanel` + **设置 → 浏览器**：多 guest 标签、历史、下载、清除数据、Agent 接管、站点策略、链接打开目标、下载询问路径、密码/联系人/解压扩展、外接 Chrome 状态条；`openBrowserTab`；快捷键 `Mod+Shift+B`。 |
| 目标规范化 | `browser-target.ts`：补全 `https://`、允许显式 `file://…/*.html`。 |
| Guest | `<webview>` + `persist:pi-browser`；无 preload / nodeIntegration；`will-attach-webview` 限制 partition。 |
| Main service | `electron/main/services/browser/`：会话、下载、标签注册表、snapshot/截图、动作队列、站点策略、高级设置。 |
| Agent | `capabilities/browser`：tabs/open/navigate/snapshot/screenshot/click/type/scroll/wait/select/dialog/download/highlight；可选 `browser_evaluate` / `browser_cdp` / `browser_external`（默认关）。 |
| 权限 | 工具层 permissions + 站点 × action_class 第二道闸门；localhost 默认放行 read/act/wait/navigate。 |

结论：L0–L4 主路径已落地（含设置页、可选 evaluate/CDP/外接 Chrome，均默认关）；WebContentsView 迁移仍为可选后续。

## 3. 目标架构

### 3.1 逻辑分层

```text
┌─────────────────────────────────────────────────────────────┐
│  Renderer：工作台浏览器壳（多标签、地址栏、下载/历史入口）   │
│  JSON 安全状态 only；不持有 webContents / CDP / 凭据         │
└───────────────────────────┬─────────────────────────────────┘
                            │ IPC（browser.*）
┌───────────────────────────▼─────────────────────────────────┐
│  Main：Browser Service                                      │
│  标签生命周期 · 导航 · 会话 partition · 下载 · 历史投影     │
│  权限决策 · 操作队列 · 人工接管 · 审计事件                  │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
                ▼                             ▼
     Guest WebContents / webview      Browser capability（Agent）
     独立 partition，不可信页面        tools → 调用 Browser Service
                                      Durable 为执行事实来源
```

原则：

1. **Guest 页面永远不可信**；主进程是唯一控制面。
2. **Pi Durable 仍是 Agent 执行事实的唯一来源**；浏览器标签状态、权限与下载元数据由 Studio SQLite / 用户数据目录投影，不回写 `~/.pi`。
3. **渲染进程只拿可序列化快照**（标签 id、url、title、loading、权限状态等），不拿句柄、路径密钥或原始扩展实现。
4. **人工可见优先**：Agent 默认操作「用户正在看的工作台浏览器」会话，而不是隐式后台无头实例（后台实例可作为高级选项，但必须在 UI 标明）。

### 3.2 源码归属（目标落点）

| 区域 | 职责 |
| --- | --- |
| `electron/main/services/browser/`（由现有 `browser-session.cjs` 等演进） | 应用服务：partition、标签/导航、下载、历史、截图与动作执行、与窗口绑定。**不**直接注册 Agent 工具。 |
| `electron/main/capabilities/browser/`（后续） | Agent 能力：manifest、工具提供、与 permissions 协作、公共 `index.cjs`。 |
| `electron/main/ipc/` 浏览器域 | 薄传输：renderer ↔ Browser Service；能力侧走既有工具通道，不把 Durable 句柄塞进 IPC。 |
| `web/src/shell/right-panel/` | 浏览器壳 UI、标签与工作台集成；样式仍在 `styles/`。 |
| `web/src/features/browser/`（若壳外逻辑变厚） | hooks、纯函数、下载/历史面板等可复用 UI；不放 Electron 专有状态。 |
| `tests/electron/*browser*`、`tests/web/*browser*` | 按边界命名；安全与工具契约必须有自动测试。 |

能力注册继续走显式静态表，禁止运行时扫目录。

### 3.3 会话与身份隔离

| 配置 | 约定 |
| --- | --- |
| 默认 partition | 继续使用独立 `persist:pi-browser`（或等价命名空间），与应用主会话、系统浏览器隔离。 |
| Cookie / 存储 | 默认**不**导入系统浏览器 Cookie；用户若需登录，在内嵌浏览器内显式登录。 |
| 工作区可选配置（后期） | 可为工作区提供独立 partition 前缀，避免项目 A 的登录态污染项目 B；默认仍是用户级 Studio 浏览器配置文件。 |
| 本地文件 | 仅显式 `file://` HTML 文档 + 同目录资源；不得变成通用文件管理器。 |
| 外链 | 「在系统浏览器打开」保持显式动作；Agent 默认不得调用系统浏览器完成敏感流程。 |

## 4. 能力分层（L0–L4）

能力按层递进；上层依赖下层稳定。产品可以只对用户开放到某一层，但实现与权限模型按层设计，避免后期推倒。

| 层 | 名称 | 内容 | 默认权限 |
| --- | --- | --- | --- |
| **L0** | 壳 | 多标签、导航、地址规范化、加载失败、外链、基本设置入口 | 用户本地操作；Agent 仅可「请求打开/聚焦」经确认或白名单 |
| **L1** | 只读感知 | 可访问性/DOM 精简快照、截图、当前 URL/title、选区文本、控制台错误摘要（可选） | 对已打开标签默认允许 Agent **读**；跨域新开页需策略 |
| **L2** | 受控操作 | 点击、类型、滚动、等待选择器/导航、前进后退、在页内查找 | 按 **站点 × 动作类** 询问或允许；写操作默认 ask |
| **L3** | 敏感面 | 文件选择、下载保存、剪贴板写入、弹窗/对话框、表单提交到未知域、清除存储 | 默认 deny 或强制 ask；高风险需更强确认 |
| **L4** | 底层 | CDP/调试器、脚本求值、挂接外部 Chrome、自定义协议 | 默认关闭；仅高级设置 + 显式信任；生产默认不暴露给普通对话 |

**人工接管**：任意时刻用户输入焦点进入页面或点击「接管」，暂停 Agent 操作队列；恢复需明确继续。接管状态投影到会话 UI 与工具结果。

## 5. 权限模型

浏览器权限是**工具权限的特化**，仍遵守全局 `deny > ask > allow`，并与 [资源作用域](../guides/resources.md) 一致：用户 / 精确工作区 / 精确会话显式规则共同参与。

### 5.1 决策键

最小决策维度：

```text
(scope) × origin_pattern × action_class × [optional tool_name]
```

建议 `action_class`：

| action_class | 示例 |
| --- | --- |
| `navigate` | 打开 URL、跟链、改地址 |
| `read` | snapshot、screenshot、get_title |
| `act` | click、type、scroll、hover、select |
| `wait` | wait_for、wait_navigation |
| `download` | 接受下载、选择保存路径 |
| `clipboard` | 读/写剪贴板 |
| `dialog` | alert/confirm/prompt、beforeunload |
| `storage` | 清 Cookie、清缓存 |
| `evaluate` | JS 求值、CDP（L4） |

`origin_pattern` 使用可审计的主机匹配（精确 host、`*.example.com`、`localhost`、`*.local`），避免过宽的 `*` 作为工作区默认。

### 5.2 默认策略（建议基线）

| 场景 | 基线 |
| --- | --- |
| `http://localhost` / `127.0.0.1` / 常见本地端口 | `read` + `act` 可工作区默认 allow；`download`/`evaluate` 仍 ask |
| 用户已打开的当前标签 | `read` allow；`act` ask（或工作区信任后 allow） |
| 新 origin 导航 | `navigate` ask |
| 未知公网 | `read` ask 或 allow-once；`act` ask |
| `evaluate` / CDP / 系统浏览器 | deny，直到用户高级设置打开 |

权限 UI 需展示：站点、动作类、永久/仅本会话/仅一次，以及最近一次 Agent 请求原因（来自工具参数的短说明）。

### 5.3 与现有 permissions 能力的关系

- 浏览器工具仍走 `electron/main/capabilities/permissions/` 的工具守卫。
- Browser Service 在执行前做**第二道**站点策略校验（防止工具层通过后 origin 已跳转到未授权域）。
- 会话内容区对浏览器相关工具步骤的展示遵循 [会话内容展示规则](conversation-content.md)：收起时显示动作与目标 URL/选择器摘要，展开可看参数与结果；成功读取的网页来源可进入来源列表（与现有 web sources 策略对齐，避免重复刷屏）。

## 6. Agent 工具契约

工具名以下表为设计约定；实现时可加 `browser_` 前缀或纳入 MCP 风格提供者，但**语义与参数应稳定**，以便技能与提示词依赖。

### 6.1 工具一览

| 工具 | 层 | 作用 | 主要参数 | 结果要点 |
| --- | --- | --- | --- | --- |
| `browser_tabs` | L0 | 列出/聚焦标签 | `action: list\|focus`，`tabId?` | 标签列表（id、title、url、active） |
| `browser_open` | L0 | 打开或复用 | `url`，`newTab?`，`tabId?` | `tabId`、最终 url |
| `browser_navigate` | L0 | 当前标签导航 | `tabId?`，`url` \| `back` \| `forward` \| `reload` | 导航后 url/title |
| `browser_snapshot` | L1 | 结构化页面快照 | `tabId?`，`mode?: dom_lite\|a11y`，`maxChars?`，`includeIframes?` | 见 §6.2；写入 `data-pi-ref` |
| `browser_screenshot` | L1 | 视口或全页图 | `tabId?`，`fullPage?` | 图片进入会话附件管道（主进程落盘/投影），不内嵌巨大 base64 到工具 JSON |
| `browser_click` | L2 | 点击 | `ref` 或坐标策略见下 | 成功/失败原因；可选新 snapshot 摘要 |
| `browser_type` | L2 | 输入 | `ref`，`text`，`submit?`，`clear?` | 同上 |
| `browser_scroll` | L2 | 滚动 | `ref?`，`direction`，`amount?` | 同上 |
| `browser_wait` | L2 | 等待 | `ref?`，`urlIncludes?`，`timeoutMs` | 超时为明确错误 |
| `browser_select` | L2 | 下拉等 | `ref`，`values` | 同上 |
| `browser_dialog` | L3 | 处理对话框 | `accept?`，`promptText?` | 需权限 |
| `browser_download` | L3 | 查询/保存下载 | `id`，`action` | 路径不直接回给不可信方；对 Agent 给安全投影 |
| `browser_highlight` | L1 | 页面标注 | `ref?`，`clear?`，`label?` | 给人看 Agent 目标；动作前也会自动高亮 |
| `browser_evaluate` | L4 | 页内脚本求值 | `expression`，`tabId?` | **默认关**；需高级开关 + 站点 evaluate allow |

**元素定位**：优先使用 snapshot 返回的稳定 `ref`（短 id），避免模型直接拼脆弱 XPath。坐标点击仅作为无障碍树缺失时的后备，并在审计中标记。

**默认不开放**的工具：任意 `eval`/CDP（仅高级开关后的 `browser_evaluate`）、读取本地任意路径、把 guest Cookie 明文导出到模型上下文。

### 6.2 Snapshot 格式（L1）

设计目标：给模型足够结构以下一步动作，同时控制体积。

```json
{
  "tabId": "tab_…",
  "url": "https://example.com/path",
  "title": "…",
  "truncated": false,
  "refs": {
    "e12": { "role": "button", "name": "保存", "value?": "", "states?": ["enabled"] }
  },
  "tree": [
    { "ref": "e1", "role": "navigation", "name": "主导航", "children": ["e2", "e3"] }
  ],
  "warnings": ["iframe:cross-origin omitted"]
}
```

约定：

- `ref` 在同一次快照内唯一；导航或大改 DOM 后失效，工具应提示重新 snapshot。
- 默认省略跨域 iframe 内部、隐藏节点的大规模文本；密码字段 value 永远不返回明文。
- 超长页面截断并声明 `truncated` / `omittedCount`，由模型缩小范围或滚动后再采。

### 6.3 执行与并发

- 同一 `tabId` 上的操作**串行队列**；禁止并行 click 导致竞态。
- 导航中的 act 自动等待可配置的安静窗口或明确 `browser_wait`。
- 用户接管时队列挂起；工具返回 `status: "paused_by_user"`。
- 标签关闭则进行中的工具失败并清理队列。

## 7. UI 与工作台

### 7.1 壳（L0）应有能力

- **多标签**：新建、关闭、切换、标题/favicon（可后期）、固定（可选）。
- **导航条**：后退、前进、刷新、地址栏（沿用 `normalizeBrowserTarget`）、加载指示、错误条。
- **溢出菜单**：历史、下载、站点权限、清除本站数据、在系统浏览器打开、复制 URL。
- **与对话协同**：Markdown 链接、来源按钮、工具结果中的 URL → `openBrowserTab`；Agent 打开的标签在工作台高亮「由 Pi 打开」。
- **接管控件**：Agent 操作中显示状态条（当前工具、目标 ref/url）；一键暂停。

### 7.2 与现有面板模型的关系

当前 `panelTabs` 中 `kind: 'browser'` 偏「单例面板」。演进方向：

- **短期**：一个 browser 面板内管理多个 guest 标签（面板 tab 仍可只有一个「浏览器」）。
- **中期**：若需要并排两个浏览上下文，再允许多个 browser 面板实例，但共享同一 Browser Service 与权限存储。

`RightPanelStart` / 命令面板 / `Mod+Shift+B` 仍是入口；不新增与工作台分裂的第二套浏览器窗口（除非用户明确「弹出」——非目标优先）。

### 7.3 渲染技术路径

| 阶段 | 方案 | 说明 |
| --- | --- | --- |
| 近 | 增强 `<webview>` | 改动面小，延续现有 attach 策略；多标签可用多个 webview 或隐藏切换。 |
| 中 | `WebContentsView`（或等价主进程视图）嵌入 | 更利于主进程统一截图、下载、CDP 与布局；壳仍在 React，视图由 main 摆放。 |
| 远 | 可选外部 Chrome attach | 仅 L4；默认关闭，文档单独警告供应链与隐私风险。 |

无论哪条路径，**IPC 与工具契约保持不变**，避免 UI 换实现时改 Agent 协议。

## 8. 安全基线（实现时不得削弱）

1. Guest：无 nodeIntegration、无 preload、contextIsolation、sandbox；仅允许 Studio partition 附着（现有 `will-attach-webview` 逻辑保留并扩展到多标签 id）。
2. 导航与请求：主框与子资源策略延续 `browser-session`；新能力不得用 `will-navigate` 单独当唯一闸门（`loadURL` 会绕过）。
3. 弹窗：默认在应用内处理或拒绝；不得静默 `shell.openExternal` 一串未知 URL。
4. 下载：默认路径在 Studio 用户数据或用户选定目录；可执行文件扩展名额外确认；路径不进入不可信日志。
5. 截图与快照：可能含隐私；进入会话投影时遵循附件与保留策略；默认不上传第三方。
6. 凭据：站点登录态留在 partition；Studio 账户凭据仍 `safeStorage`，禁止写入 guest 或扩展数据。
7. 扩展：不得提供可执行浏览器脚本贡献点；声明式 UI 只能发「打开 URL / 聚焦标签」类意图，由主进程执行。

## 9. 数据与审计

| 数据 | 存储 | 说明 |
| --- | --- | --- |
| 标签运行态 | 主进程内存 | tabId、webContents、队列、接管标志 |
| 最近标签 / 历史 | SQLite 或 `~/.pi-studio` 下托管文件 | 可关；不含密码字段 |
| 站点权限 | SQLite（permissions 域或 browser 专用表） | 与 scope 模型一致 |
| 下载元数据 | SQLite + 磁盘文件 | 保留校验和与来源 URL |
| 工具审计 | 会话事件 / request-trace 可观测 | 记录 action_class、origin、结果码；不记录密码与完整 Cookie |

Durable 会话记录工具调用与结果投影；浏览器服务状态不是第二套对话真相源。

## 10. 分阶段交付

### Phase 1 — 工作台浏览器壳（L0）

- 多标签、下载列表（至少捕获与打开目录）、简易历史、设置里的「清除浏览器数据」。
- 面板与 `openBrowserTab` API 稳定；链接打开行为统一。
- 测试：地址规范化、session 拒绝非法 scheme、多标签切换不串 session 配置。

### Phase 2 — Agent 只读（L1）

- `browser_tabs` / `open` / `navigate` / `snapshot` / `screenshot`。
- 能力模块注册 + permissions 接线；会话 UI 展示浏览器步骤。
- 默认仅 read；navigate 对新 origin ask。

**状态（已实现）**：主进程 `services/browser` 提供标签注册表、命令桥（`pi:browser-command`）、DOM-lite snapshot 与视口截图；`capabilities/browser` 注册五件工具；`browser_tabs` / `browser_snapshot` / `browser_screenshot` 列入 SAFE_TOOLS；默认 Agent 工具列表迁移至 version 4 自动加入浏览器工具；渲染进程 guest 在 `dom-ready` 后上报 `webContentsId` 并完成 open 命令 ack；会话活动摘要识别 `browser_*`。

### Phase 3 — 受控操作与站点权限（L2–L3 核心）

- click/type/scroll/wait/select；串行队列与人工接管。
- 站点 × 动作权限 UI；localhost 友好默认。
- dialog/download 最小闭环。

**状态（已实现）**：`browser_click` / `type` / `scroll` / `wait` / `select` / `dialog` / `download`；snapshot 写入 `data-pi-ref` 供动作定位；每标签串行队列 + 全局/标签接管暂停；`studio.browser.sitePolicies` 第二道站点策略（localhost 默认放行 read/act/wait/navigate）；浏览器工具栏「接管」与「允许当前站点操作」；默认工具列表 version 5；`browser_wait` / `browser_download` 进入 SAFE_TOOLS，写操作仍走 ask。

### Phase 4 — 增强与 L4 可选

- 页面内标注（给人看 Agent 目标）、更强 a11y、iframe 策略细化。
- 可选 CDP / evaluate（默认关）。
- 评估 WebContentsView 迁移；文档化外部 Chrome attach 风险（若做）。

**状态（已实现）**：

- snapshot 写入 `data-pi-ref`；支持 `mode: dom_lite | a11y`；同域 iframe 可遍历，跨域记入 `warnings`。
- 点击/输入/选择等动作前自动高亮目标；`browser_highlight` 可显式标注或清除（设置可关批注）。
- **设置 → 浏览器**：总开关、链接打开位置、完整网址、清除数据、下载目录、历史访问、网站权限表、开发者模式。
- `studio.browser.preferences`（兼容旧 `evaluateEnabled`）：evaluate / cdp / externalChrome 默认 `false`；Agent 控制默认开。
- `browser_evaluate` 需全局 evaluate + 站点 `evaluate=allow`；`browser_cdp` 需全局 cdp + 站点 `cdp=allow`；`browser_external` 需 cdp + externalChrome，经本机调试端口发现/连接。
- 关于页保留清除数据入口并链到浏览器设置；不进入默认工具白名单自动开通 L4 工具。
- 下文 §14 记录 WebContentsView 结论与外接风险（外接已实现但默认关）。

每阶段结束须满足：相关 `pnpm test` 域用例、安全回归、文档与 `docs/README.md` 索引仍准确。

## 11. 验收标准（跨阶段）

1. 用户能在侧栏完成多标签浏览 localhost 与文档站，不被迫跳系统浏览器。
2. Agent 在授权下能打开页面、基于 snapshot 指认控件并完成简单表单流程；用户能看见并一键接管。
3. 未授权站点不能被工具静默连续操作；权限决定可复盘。
4. Guest 无法获得 Node 或应用 preload；非法 webview 附着仍被拒绝。
5. 渲染进程日志与 IPC 载荷无可敏感明文凭据；工具结果体积受控。
6. 与 Durable、permissions、会话展示规则无第二套冲突语义。

## 12. 开放问题

- 工作区级 partition 是否默认开启，还是仅企业/多项目用户需要。
- snapshot：默认 `dom_lite`，可选 `a11y`；同域 iframe 默认纳入、跨域省略并警告（已定）。
- 「由 Agent 打开的标签」是否自动随会话归档关闭，以免登录态残留。
- 下载的默认目录：Studio 托管目录 vs 系统下载文件夹。
- WebContentsView：见 §14；当前继续 webview 多实例，IPC/工具契约已与视图实现解耦。

决策应写回本文对应小节，避免只存在于聊天记录。

## 13. 维护入口（当前代码）

| 路径 | 说明 |
| --- | --- |
| `web/src/shell/right-panel/BrowserPanel.tsx` | 多标签浏览器壳（历史、下载、清除数据） |
| `web/src/features/browser/BrowserSettings.tsx` | 设置 → 浏览器（偏好、权限、L4） |
| `web/src/shell/right-panel/browser/` | 标签与历史纯函数 |
| `web/src/shell/right-panel/browser-target.ts` | 地址规范化 |
| `web/src/shell/right-panel/useAppWorkbench.ts` | `openBrowserTab`（面板内新开 guest 标签） |
| `web/src/shared/shortcuts.ts` | `openBrowser` / `Mod+Shift+B` |
| `electron/main/services/browser/` | partition、下载、标签、snapshot、动作、策略、高级设置 |
| `electron/main/capabilities/browser/` | Agent 浏览器工具 |
| `electron/main/services/browser-session.cjs` | 兼容 re-export |
| `electron/main/ipc/browser.cjs` | 浏览器 IPC |
| `electron/main/services/local-html.cjs` | 本地 HTML 白名单 |
| `electron/main/window.cjs` | `will-attach-webview` |
| `electron/main/index.cjs` | webview 创建后的弹窗与导航策略；初始化 Browser Service |

### 落地状态摘要

| 阶段 | 状态 |
| --- | --- |
| Phase 1 壳 | 已实现 |
| Phase 2 只读 | 已实现 |
| Phase 3 操作与站点策略 | 已实现 |
| Phase 4 标注 / a11y·iframe / 设置页 / 可选 evaluate·CDP·外接 Chrome | 已实现（L4 默认关） |

相关代码：`electron/main/services/browser/`、`electron/main/capabilities/browser/`、`web/src/shell/right-panel/BrowserPanel.tsx`、`tests/electron/browser-*.test.cjs`。

本文生效后，浏览器相关的架构变更应先更新本文与索引，再改代码中的公共契约。

## 14. Phase 4 决策备忘

### 14.1 页面标注

- Agent 在 click/type/select/scroll-to-ref/wait-ref 前**尽力**高亮 `data-pi-ref` 目标（蓝框 + 角标）。
- `browser_highlight` 供显式标注或 `clear`；属 `read` 类站点策略。
- 标注样式注入 guest 文档，不经过扩展 HTML/CSS 通道。

### 14.2 Snapshot 模式与 iframe

| 项 | 约定 |
| --- | --- |
| 默认 mode | `dom_lite`：可交互与标题类节点 |
| `a11y` | 更强调 role/name、tabIndex、常见 ARIA 状态 |
| 同域 iframe | 默认递归采集，frame 路径记在 ref 元数据 |
| 跨域 iframe | 不读内部 DOM；`warnings` 含 `iframe:cross-origin omitted` |
| 定位 | 快照时写入 `data-pi-ref`；导航或大改 DOM 后需重新 snapshot |

### 14.3 L4：evaluate / CDP / 外接 Chrome（默认关）

存储键：`studio.browser.preferences`（`evaluateEnabled` 仍双写旧键以兼容）。

| 能力 | 全局开关 | 站点策略 | 工具 |
| --- | --- | --- | --- |
| 脚本求值 | `evaluateEnabled` | `evaluate=allow` | `browser_evaluate` |
| 完整 CDP（guest） | `cdpEnabled` | `cdp=allow` | `browser_cdp` |
| 外接 Chrome | `externalChromeEnabled` 且必须 `cdpEnabled` | 调试端口信任 | `browser_external` |

1. UI：**设置 → 浏览器 → 开发者模式**（风险升高提示）；关于页仅快捷入口。
2. localhost **不**自动放行 evaluate/cdp。
3. 工具权限仍可再挡一层；**不**写入默认 Agent 工具白名单自动开通。
4. 结果截断；不导出 Cookie / 密码框明文；部分高危 CDP 方法（如 Browser.*、创建 Target）直接拒绝。
5. 外接：仅 `http://127.0.0.1:9222` 类调试端点；`/json/list` 发现 page 目标；WebSocket CDP；**不**并入 `persist:pi-browser`，**不**替代内嵌默认会话。

### 14.4 WebContentsView 迁移评估

| 维度 | 继续 `<webview>`（当前） | 迁到 `WebContentsView` |
| --- | --- | --- |
| 改动面 | 小；壳在 React 内 | 主进程布局与 resize、与 React 面板同步成本高 |
| 截图 / 下载 / 动作 | 已通过 webContentsId 在主进程完成 | 略更直接，收益有限 |
| 多标签 | 多 webview 实例已可用 | 多 View 叠放需自管 z-index 与焦点 |
| CDP | webview 的 webContents 亦可 debugger | View 同等能力 |
| 风险 | webview 长期标记复杂 | 大改 UI 合成，回归面大 |

**结论（Phase 4）**：保持 webview；工具与 IPC 契约不绑定视图类型。若 Electron 弃用 webview 或出现无法在 guest 完成的主进程布局需求，再立项迁移，并保持 `tabId` / 工具参数不变。

### 14.5 外部 Chrome attach（已实现，非默认）

| 风险 | 说明 |
| --- | --- |
| 隐私 | 可触及该调试实例中的 Cookie、已登录会话与扩展状态 |
| 供应链 | 依赖本机 Chrome 版本与调试端口，行为不一致 |
| 安全 | 远程调试端口若暴露等于把浏览器控制面打开 |
| 产品边界 | 与「工程工作台独立配置文件」定位并列，不得替换默认会话 |

约定：默认关；设置页双重警告；禁止静默 attach；断开可一键清理会话；**不得**替代内嵌 `persist:pi-browser`。
