# 升级计划：Pi Durable 1.4.0 → 1.5.0

- 目标版本：`@earendil-works/{pi-durable,pi-ai,chord,pi-mcp,pi-telemetry}` `1.4.0` → `1.5.0`
- 上游发布日期：1.5.0 = 2026-11-02，1.4.0 = 2026-10-21
- 性质：**破坏性 minor**。不是加特性，是流式渲染模型、工具 schema 体系、失败语义三处同时改契约。
- 判断：**值得升，但不能在现有代码上直接改版本号**。下面给出四个阶段，其中阶段 0/1 可以在 1.4.0 上先合入。
- 状态：**阶段 0–2 与阶段 3 的代码部分已完成**，实现记录见第 8 节；只剩需要真机跑的手工 QA。

## 1. 实测基线

在 `git archive HEAD` 的隔离副本上真实装配、真实跑测试（不是读 changelog 推断）：

| 组合 | 通过 | 失败 |
|---|---|---|
| HEAD + 1.4.0（现状） | 408 | 0 |
| HEAD + 1.5.0（只改版本号） | 389 | 19 |
| HEAD + 1.5.0（只做阶段 1 的 schema 解耦） | **408** | **0** |

19 项失败中：3 个 `mcp-runtime` 用例、1 个 `studio-db-recovery` 用例、5 个集成测试整文件失败，其余为模块级连锁失败。

### 最重要的一个实测结论

只做阶段 1 的 schema 解耦、**完全不动实时管道**，1.5.0 上测试就是 **408/0 全绿**——而此时应用仍然不可用：`watchEvents()` 已删除（没有流式）、`taskGraph()` 已删除（任务图 IPC 会抛错）、`ACTIVE_TASK_STATES` 永远匹配不到待调度任务。

也就是说：**这套测试无法验证本次升级，也无法阻止它上线后崩溃。** 阶段 0 的护栏测试不是加分项，是这次升级能否安全落地的前提。

原因很清楚：单元测试大量使用 mock，而 mock 自己声明了上游 API。例如 `tests/electron/temporary-chat.test.cjs` 里的假 `watchEvents()` 在 1.5.0 上仍然 5/5 通过——它测的是 Studio 自己的分支逻辑，从未测到真实的 Durable 契约。

运行期探针（直接 import 1.5.0 实测）：

| 符号 | 1.4.0 | 1.5.0 |
|---|---|---|
| `piAi.Type` | object | **undefined** |
| `durable.watchEvents` | function | **undefined** |
| `Harness.taskGraph` | function | **undefined** |
| `Harness.retryTask` | function | **undefined** |
| `Harness.watchTaskGraph` | — | function |
| `TaskInspection.state.kind` 待调度态 | `"ready"` | `"pending"` |
| `pi.live` 文档版本 | 1 | 3（新增必填 `run.turns`） |
| SQLite 表结构版本 | 2 | 2（**未变**） |

## 2. 影响面

### 阻断项（不处理则应用不可用）

| # | 项目 | 位置（当前行号） | 说明 |
|---|---|---|---|
| B1 | `piAi.Type` 不再存在 | `studio-todo.cjs:512`、`studio-long-task.cjs:306`、`studio-builtins.cjs:460/1035/1119`、`mcp-runtime.cjs:344` | 6 个注入点，覆盖 128 处 `Type.*` 调用。任一扩展工厂在初始化时 `Type.Object` 抛 `TypeError`，`createRuntime` 直接失败 |
| B2 | `watchEvents()` 被删除 | `durable-conversations.cjs:524`、`:2043`、`temporary-chat.cjs:240` | Studio 的实时流式管道整体建在它上面：`handleAgentEvent`（`:1776-2032`）分发 20+ 事件类型，产出 16 种 IPC 事件 |
| B3 | `Harness.taskGraph()` 被删除 | `durable-conversations.cjs:1657` | 改用 `watchTaskGraph()`，取 `.value` 后 `stop()` |
| B4 | `TaskInspection.state.kind` 的 `"ready"` → `"pending"` | `durable-conversations.cjs:83` 的 `ACTIVE_TASK_STATES` | 该集合含 `'ready'`、不含 `'pending'`。改版本后**永远匹配不到待调度任务**，`runningConversations`（`:956`、`:2156`）静默失效——会话"运行中"状态、子代理存活判断都会错，且不报错 |
| B5 | `onReport(error, info)` → `onReport(report)` | `durable-runtime.cjs:159` | `info.type` → `report.kind`，`session_failed` → `storage_failed`；新增 `task_interrupted` 等 kind |

### 需要适配（不阻断，但功能退化或需要新语义）

| # | 项目 | 位置 | 说明 |
|---|---|---|---|
| A1 | 扁平快照形状消失 | `liveSnapshotDto` `:184`、`temporarySnapshot` `:522` | 1.4 的 `snapshot` 是扁平对象（`run/generation/tools/inbox/agent/usage`）。1.5 变为 `ConversationView = { conversation, entries, before, docs }`，需要一层投影还原 |
| A2 | `submission` 事件无等价物 | `durable-conversations.cjs:1930`；renderer `App.tsx:2105` | 1.4 靠 `submission.updated` 的 `record.reason` 显示失败原因。1.5 用 `pi.live.runFailure` 取代 run 级失败，提交级查询走 `Harness.submission(id)` |
| A3 | `RunFailureReason` 取值集合变了 | `App.tsx:334` `submissionFailureText` | `run_failed` 消失；新增 `interrupted`、`restart_limit`、`nothing_to_answer`、`turn_limit`、`faulted`、`orphaned`。不改会显示"本轮运行没有完成（turn_limit）。"这类原始英文 |
| A4 | watch 回调形状变化 | A2/B2 一并 | `stream.start(events[])` → `watch.start(call)`，`call = { kind:"value", value, ops, retired }`；`WatchEnd` 按 `kind` 标记（`reason` → `kind`） |
| A5 | `ConversationView.entries` 是窗口 | 新代码 | 初始最近 50 条，超过 100 条一次性裁回 50。派生"新增 entry"必须按 ID 去重并容忍窗口裁剪与 `[["r", view]]` 根替换 |
| A6 | 流式落盘延后 | 运维项 | `settings.progress.persistWithinMs` 默认 1000ms：watch 立即看到，落盘最多晚 1s。崩溃最多丢约 1 秒流式内容（原来约 100ms） |

### 预存在缺陷（与本次升级无关，但会被这次改动触碰）

| # | 项目 | 证据 |
|---|---|---|
| P1 | `examples/extensions/agent-starter/extension.mjs` 与 `docs/extensions.md:197` 教人 `import { Type } from '@earendil-works/pi-durable'`，但该导出**在 1.4.0 就已不存在** | 实测 `import()` 抛 `SyntaxError: The requested module ... does not provide an export named 'Type'` |
| P2 | `tools/cli/pi-studio-extension.mjs:620` 的脚手架模板同样生成坏导入 | 同 P1，新扩展开箱即坏 |
| P3 | `pi-studio-extension validate` 不加载入口模块，上述坏扩展仍报 `"valid": true` | 实测 `validate examples/extensions/agent-starter` 返回 valid |

### 确认**不需要**改（避免过度工作）

- **没有自定义 `Storage`**：用的是内置 `openNodeSqliteStorage()`，所以 `commit(writes, adopt)` → `commit(batches, receive)` 的重写不适用。
- `conversation.commit(tx => …)`、`api.commit(tx => …)`、`runtime.commit()` 的 tx 形态未变。
- `conversation.entries(query, limit, cursor, ctx)` 分页签名未变（`scanEntries`、`scanDisplayMessages`、`firstUserMessage` 全部不受影响）。
- `defineDoc`/`defineTask` 定义与版本号不需要动。
- 未使用 `structuredOutputSchema`、`subscribeCommits`、`retryTask`、`viewState`、`documentState`、`observeDoc`。
- `chord`：Studio 只用 `BACKGROUND_CONTEXT` 和 `withAbortSignal`，1.5.0 的 Chord 破坏项（watch 形状、`traceIn` 参数顺序、`runCounted`）不命中。
- `pi-mcp`：只做 OAuth URL 加固与 README 修正，`McpClient`/传输层/`toLlmContent` 无变化。
- `pi-telemetry`：1.5.0 无 CHANGELOG 条目。

## 3. 关键设计决策

### D1：工具 schema 用 Studio 自有的 JSON Schema 构造器，而不是改 128 处调用

**背景**：1.5.0 让 `defineTool()` 接受任何 JSON Schema 对象；TypeBox 不再是上游依赖。

**两个选项**：

| | A. 直接改用 `pi-schema` | B. 单文件构造器输出等价 JSON Schema |
|---|---|---|
| 改动量 | 128 处调用全部改写 | 6 处注入点 + 1 个新文件 |
| 行为变化 | `obj()` **默认 closed**（`additionalProperties:false`），TypeBox 默认 open → 模型多传字段会被拒 | 无。输出与现状逐字节一致 |
| 与上游一致 | 是 | 否（但 `defineTool` 已显式支持任意 JSON Schema） |
| 适合时机 | 升级完成、稳定之后 | 本次升级 |

实测证据：TypeBox `Type.Object({a:String()})` → `{"type":"object","required":["a"],"properties":{"a":{"type":"string"}}}`；`pi-schema obj({a:str()})` → `{...,"additionalProperties":false}`。差异真实存在。

**决定**：本次用 B，`electron/services/tool-schema.cjs`，只实现代码里实际用到的 9 个构造器（`Object/String/Number/Boolean/Array/Union/Literal/Optional/Unsafe`），用 WeakSet 记录可选属性。用**冻结 fixture** 固化输出，防止后续漂移。

**并在同一次改动里把 `pi-schema` 记为显式依赖候选**：实测 `@earendil-works/pi-schema` 在应用根目录**不可解析**（它是 pi-durable 的传递依赖），将来真要 import 必须写进 `package.json`。

### D2：所有 Durable → IPC 的投影收敛到一个纯函数模块

`electron/services/durable-view.cjs`，不 import 任何 `@earendil-works/*`，只做数据变换：

```js
// ConversationView -> 1.4 时代的扁平快照形状（让 liveSnapshotDto 保持不变）
viewToLive(view) -> {
  run, generation, tools, nestedTools, compactions,
  compactionFailure, inbox, agent, usage
}

// 两次快照的差异 -> Studio 已有的 IPC 事件
diffLive(prev, next) -> [{ type, payload }, ...]

// 窗口内新增的 entry（按 ID 去重，容忍窗口裁剪与根替换）
appendedEntries(prevIds, entries) -> EntryRecord[]
```

收益：
- `durable-conversations.cjs` 的 250 行事件分发被替换为「取 view → `viewToLive` → `diffLive` → emit」，行为与今天一致。
- **未来 Durable 再改视图契约，只改这一个文件**。这是本计划对"方便后续同步"的核心贡献。
- 纯函数可以用 fixture 测试，不需要真实 Harness、不依赖 1.4 或 1.5。

**关键约束**：IPC 契约（`web/src/types/durable-types.ts`）保持不动。渲染层是最大、最贵的部分，本次升级不应触碰它（唯一例外见 D3）。

### D3：失败语义对齐 `pi.live.runFailure`，并顺带修好文案断层

`run.failed` 事件保留，但 payload 增加 `reason` 与 `detail`：

```js
// 现在
payload: { taskId, kind, message, running }
// 之后
payload: { taskId, kind, message, reason, detail, running }
```

`App.tsx` 的 `submissionFailureText` 增补新取值（`interrupted` / `restart_limit` / `nothing_to_answer` / `turn_limit` / `faulted` / `orphaned` / `reset` / `aborted`）。这是本次唯一需要动前端的改动，约 15 行，且是用户可见的改进——今天这些情况下界面只会显示英文枚举值。

## 4. 分阶段计划

### 阶段 0 — 护栏与文档修正（不升级依赖）

**目的**：让"上游删了个 API"这件事在 CI 里可见，而不是在用户机器上可见。

| 交付物 | 内容 |
|---|---|
| `tests/electron/durable-api-surface.test.cjs` | 断言 Studio 依赖的符号存在：`piAi` 的模型/消息导出、`pi-durable` 的 `Harness/defineTool/defineExtension/defineDoc/defineTask/createRegistry/MemoryStorage`、`Harness` 原型上的 `watchTaskGraph/observeConversation/inspect/getTask/resume/commit`、`chord/context` 的 `BACKGROUND_CONTEXT`。上游删任何一项即红 |
| `tests/integration/durable-live-projection-loop.test.mjs` | **最关键的一个**。用真实 Harness 端到端跑通 Studio 的投影路径（见下方配方），断言 IPC 事件序列。它在 1.4.0 上必须绿，在删除 `watchEvents` 后必须红 |
| `tests/electron/tool-schema.test.cjs` | fixture 固化工具 schema 输出（阶段 1 才有实现，先建结构） |
| `tools/upgrades/check-durable.mjs` | 读 npm `dist-tags` + 拉 CHANGELOG，输出锁定版本与 `latest` 之间的条目摘要；接 `pnpm run upgrade:check` |
| `docs/upgrades/README.md` | 已完成 |
| 修 P1/P2/P3 | 示例与文档改为从 `@earendil-works/pi-ai` 取 `Type`（1.4.0 可用）；脚手架模板同步；`validate` 增加"能 import 入口模块"的检查 |

#### 护栏测试配方（已确认可行）

`@earendil-works/pi-ai` 导出 `fauxProvider` / `fauxAssistantMessage` / `fauxToolCall` / `createModels`，可以在 `MemoryStorage` 上跑一个**脚本化的真实模型**，无需网络、无需凭据。`tests/integration/durable-long-task-loop.test.mjs` 已有现成范例。

```js
const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', name: 'probe' }] });
faux.setResponses([
  () => fauxAssistantMessage('first chunk'),
  () => fauxAssistantMessage(fauxToolCall('ls', { path: '.' }), { stopReason: 'toolUse' }),
  () => fauxAssistantMessage('done'),
]);
const models = createModels();
models.setProvider(faux.provider);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
// 走 Studio 自己的 ensureWatch/applyView 路径，收集 emit 出来的 IPC 事件
```

必须断言的事件序列：`snapshot` → `run.started` → `assistant.updated`（至少一次，证明流式）→ `transcript.appended` → `tool.execution.*` → `run.completed`。再加一条异常路径：模型返回错误时 `run.failed` 带 `reason: "model_error"`。

**验收**

```sh
pnpm run extension:schema
pnpm test            # 408 通过 / 0 失败
node tools/upgrades/check-durable.mjs   # 报出 1.5.0
```

反向验证（必须做）：把 `watchEvents` 那一行换成不存在的 API，确认新测试**变红**。否则护栏是假的。

**回滚**：纯新增，直接 revert。

---

### 阶段 1 — 工具 schema 解耦（不升级依赖）

**目的**：把 B1 从阶段 2 里摘出去，让阶段 2 的 diff 只剩实时管道。

| 改动 | 位置 |
|---|---|
| 新增 `electron/services/tool-schema.cjs` | 9 个构造器，输出与 TypeBox 逐字节一致 |
| `Type: piAi.Type` → `Type: toolSchema` | `studio-todo.cjs:512`、`studio-long-task.cjs:306`、`studio-builtins.cjs:460/1035/1119` |
| `piAi.Type.Unsafe({...})` → 直接传对象 | `mcp-runtime.cjs:344` |
| 测试里的 `Type` 导入同步 | `tests/integration/` 7 个文件（见下方验收说明） |
| 冻结 fixture 并断言 | `tests/electron/tool-schema.test.cjs` |

**验收**

```sh
pnpm test                                   # 408 / 0
pnpm run extension:schema
node tools/cli/pi-studio-extension.mjs validate examples/extensions/agent-starter --scope user --json
# 另需：能 import 该示例模块（阶段 0 加的检查）
```

附加验证：在隔离副本里把版本改成 1.5.0，确认 19 项失败**全部消失**。

注意这个结果的两面性：它证明 B1 已彻底解决，但同时也证明测试对 B2–B5 完全无感（实测 408/0 而应用不可用）。所以阶段 1 的完成**不代表可以发布**，必须等阶段 2 与阶段 3 的手工 QA。

阶段 1 的改动除 4 个生产文件 + 1 个新文件外，还包含 7 个集成测试文件中的 `Type` 导入（`durable-todo-loop`、`durable-long-task-loop`、`durable-subagent-loop`、`durable-resource-loop`、`durable-request-trace-loop`、`durable-edit-context-loop`、`metrics-runtime-pi`），其中一部分是 `piAi: { Type }` 注入、一部分直接 `import { Type }`。

**回滚**：revert 单个 PR，无数据影响。

---

### 阶段 2 — 升级依赖并切换到视图投影（原子，不可拆）

**为什么原子**：改完版本号，`piAi.Type` 立刻是 `undefined`。不存在"升了版本但还没接线"的可运行中间态。

| # | 改动 | 位置 |
|---|---|---|
| 1 | 5 个包 → `1.5.0` | `package.json` |
| 2 | 新增 `electron/services/durable-view.cjs`（`viewToLive`/`diffLive`/`appendedEntries`） | 新文件 |
| 3 | `liveSnapshotDto` 改为接收 `view`，内部走 `viewToLive` | `durable-conversations.cjs:184` |
| 4 | `ensureWatch`：`watchEvents(...)` → `conversation.watch(context)`，`stream.start(events[])` → `watch.start(call)` | `durable-conversations.cjs:2043`、`:2069` |
| 5 | `handleAgentEvent` 删除，替换为 `applyView(prev, next, entry)`（约 250 行 → 约 40 行） | `durable-conversations.cjs:1776-2032` |
| 6 | `temporarySnapshot` 改用 `conversation.watch()` 取首值后 `stop()` | `durable-conversations.cjs:522` |
| 7 | `taskGraph(id)` → `watchTaskGraph()` + `.value` + `stop()` | `durable-conversations.cjs:1657` |
| 8 | `ACTIVE_TASK_STATES`：`'ready'` → `'pending'` | `durable-conversations.cjs:83` |
| 9 | `onReport(error, info)` → `onReport(report)`，`info.type` → `report.kind` | `durable-runtime.cjs:159` |
| 10 | 删除死代码 `applyMessageChanges`（`:1687`）与 `partialMessage` 中不再需要的分支 | `durable-conversations.cjs` |
| 11 | `run.failed` payload 增 `reason`/`detail`；`submissionFailureText` 增补新取值 | `durable-conversations.cjs`、`App.tsx:334` |

**`temporary-chat.cjs` 同步改造**（`:240`）：同样换成 `conversation.watch()`，从 `pi.live.generation.message` 取流式内容。

**注意点**

- `conversation.watch()` 需要 `Conversation` 句柄，`watchEvents(harness, id, ctx)` 只需要 id。`ensureWatch` 已经有 `getConversationHandle(row.id)`，可直接用。
- `watch.start` 的回调参数是**单个对象**，不是数组。
- `disposeWatch` 里 `entry.stream.stop().catch(...)` 语义不变（`stop()` 返回 `WatchEnd`）。
- 首值无 `prev`：只发 `snapshot`，不发增量事件。
- `[["r", view]]` 根替换（>10000 条待处理操作）时，`prevIds` 视为未知，按"全部当作新增或全部忽略"二选一——**必须选"全部忽略"**，否则会重复追加整段历史。

**验收**

```sh
pnpm test                # 必须 408+ / 0（不是 389/19）
pnpm run build
pnpm run extension:schema
git diff --check
```

手工 QA（`tools/qa/` 或直接跑 `pnpm dev`）必须走完：

1. 长回答流式渲染（>140KB，验证 1.5.0 的内存修复路径）
2. 并行工具调用（多 slot 状态流转）
3. 中止运行 → `runFailure.reason = aborted` 的中文文案
4. 模型报错 → `model_error` 文案
5. 子代理（后台任务）跑完后主会话的 `running` 状态正确
6. 关窗 → 重开 → 会话仍在运行（任务恢复 + `runningConversations` 重建）
7. 临时聊天（`temporary-chat`）流式正常

**回滚**：revert PR + **恢复升级前的 `pi-studio.sqlite` 快照**。理由见下节。

---

### 阶段 3 — 回归、文档与降级预案

| 项目 | 内容 |
|---|---|
| 降级预案 | 升级前备份 `app.getPath('userData')/pi-studio.sqlite`。`pi.live` 已升到 v3，旧版读不了新写入的会话 |
| 流式落盘取舍 | 若"崩溃丢 1 秒"不可接受，设 `settings.progress.persistWithinMs: 0` 恢复逐次落盘（代价：每次 partial 一次存储事务） |
| 文档 | `docs/extensions.md` 的 schema 指南改为**纯 JSON Schema 字面量**（1.5.0 原生支持，扩展作者无需任何 import，也避开模块解析问题） |
| 示例 | `examples/extensions/agent-starter/extension.mjs` 与 CLI 模板同步更新 |
| 升级记录 | 在本文件末尾补"实际坑"，并把可测的补进守卫测试 |

**可选（不在本次范围）**：逐步采纳 `pi-schema` 的 `obj()` 闭集默认值。需要逐个工具决定是否 `{ open: true }`，并补工具参数校验测试。收益是与上游一致，成本是 128 处改写 + 模型行为可能变化。建议 1.5.0 稳定运行一段时间后单独评估。

## 5. 附录：事件映射表

`ConversationView` 来源：`docs['pi.live']`（`live`）、`docs['pi.inbox']`、`docs['pi.agent']`、`docs['pi.usage']`，以及 `entries`。

| Studio IPC 事件 | 1.4 来源 | 1.5 来源 |
|---|---|---|
| `snapshot` | `watchEvents().snapshot` | `watch.value` → `viewToLive()` |
| `run.started` | `run_start` | `live.run` 由无到有 |
| `run.completed` | `run_end` | `live.run` 由有到无（注意：`afterRun` 任务期间 `run` 仍在，语义更准） |
| `run.failed` | `task_failed` | `live.runFailure` 出现 |
| `assistant.updated` | `message_start`/`message_update` + 增量 ops | `live.generation.message` 变化 |
| `assistant.completed` | `message_end` | `entries` 新增 assistant entry |
| `transcript.appended` | `entry_appended`、`tool_execution_end.entry` | `appendedEntries(prevIds, entries)` |
| `tool.execution.started/updated/completed` | `tool_execution_start/update/end` | `live.tools[]` 的 `status`/`output`/`entry` 差异 |
| `inbox.updated` | `inbox_update` | `docs['pi.inbox'].items` 变化 |
| `agent.updated` | `agent_changed` | `docs['pi.agent']` 变化 |
| `usage.updated` | `usage_changed` | `docs['pi.usage']` 变化 |
| `retry.updated` | `auto_retry_start/end` | `live.generation.retry` 出现/消失 |
| `compaction.started/completed` | `compaction_start/end` | `live.compactions[]` / `live.compactionFailure` |
| `submission.updated` | `submission` | **无等价物**。run 级失败用 `live.runFailure`；单个提交用 `Harness.submission(id)` |
| `turn.diff` | Studio 自有 | 不变 |

`live` 字段（`pi.live` v3，已实测）：`run{taskId,inputs,turns,first?,afterRun?}`、`generation{attempt,message?,retry?,deferred?}`、`tools[]`、`nestedTools[]`、`compactions[]`、`compactionFailure{reason→trigger,error}`、`runFailure{reason,detail?,taskId,inputs,first?}`。

## 6. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 实时管道无自动化覆盖 | **已实测确认**：阶段 1 后 1.5.0 上 408/0 全绿，应用仍不可用 | 阶段 0 的 `fauxProvider` 端到端测试（含反向验证）；阶段 2 强制 7 项手工 QA |
| `pi.live` 窗口/根替换处理错误 | 历史重复或丢失 | `appendedEntries` 按 ID 去重；根替换时忽略而非全量追加 |
| 工具 schema 静默变化 | 模型参数校验行为变化，工具开始报参数错误 | 阶段 1 冻结 fixture，逐字节比对 |
| `ACTIVE_TASK_STATES` 静默失效 | "运行中"状态错、子代理存活判断错，**不报错** | 阶段 2 第 8 项；QA 第 5/6 项必须覆盖 |
| 降级不可行 | 出问题只能回滚到快照 | 阶段 3 备份要求写进发布清单 |
| 上游继续 1.x 破坏性发版 | 每次都要重复迁移 | `docs/upgrades/README.md` 流程 + 守卫测试 |

## 7. 执行清单

阶段 0–2 完成后的实测：`pnpm test` **449 通过 / 0 失败**，`pnpm run build` 通过，`git diff --check` 干净。

- [x] 阶段 0-1：`tests/electron/durable-api-surface.test.cjs`
- [x] 阶段 0-2：`tools/upgrades/check-durable.mjs` + `upgrade:check` 脚本
- [x] 阶段 0-3：修正 P1/P2/P3（示例、文档、脚手架、validate 加载检查）
- [x] 阶段 1-1：`electron/services/tool-schema.cjs`
- [x] 阶段 1-2：6 个注入点切换
- [x] 阶段 1-3：`tests/electron/tool-schema.test.cjs` + 冻结 fixture
- [x] 阶段 2-1：`package.json` 5 个包 → 1.5.0
- [x] 阶段 2-2：`electron/services/durable-view.cjs` + `tests/electron/durable-view.test.cjs`
- [x] 阶段 2-3：`durable-conversations.cjs` 接线（第 3–6、10 项）
- [x] 阶段 2-4：`taskGraph` → `watchTaskGraph`
- [x] 阶段 2-5：`ACTIVE_TASK_STATES` 修正
- [x] 阶段 2-6：`onReport` 形状
- [x] 阶段 2-7：`run.failed` reason/detail + 前端文案
- [x] 阶段 2-8：`temporary-chat.cjs` 接线
- [x] 阶段 3-2：文档与示例更新
- [ ] 阶段 3-1：7 项手工 QA（需要真机启动 Electron）
- [ ] 阶段 3-3：降级预案与发布说明（发布前执行）

## 8. 实现记录（与计划的偏差）

计划在执行中被三处现实修正，记录以便下次复用：

1. **端到端护栏测试从阶段 0 挪到阶段 2。** 阶段 0 要在 1.4.0 上全绿，而该测试必须走 `conversation.watch()`——1.4.0 没有这个 API。强行在阶段 0 写只能针对 `watchEvents` 写一遍再重写，属于一次性工作。最终落点：`tests/integration/durable-live-projection-loop.test.mjs`，两个用例分别覆盖正常流式与 `model_error`。
2. **`Optional()` 必须返回浅拷贝。** 实现时先做了就地标记（WeakSet），与 TypeBox 的 `Type.Object({ a: shared, b: Optional(shared) })` → `required: ["a"]` 不一致。改成拷贝后逐字节对齐，并由 fixture 测试锁定。
3. **`submission.updated` 从 IPC 契约中删除。** 计划里写的是"保留并扩展 `run.failed`"，实际实现时发现 `submission.updated` 只有 `run.failed` 这一个用途，留着就是死代码。同时把 `submissionFailureText` 的 `run_failed` 分支换成 `RunFailureReason` 全集。

另外三个实现细节值得记住：

- 1.5.0 的 `pi.live` 把压缩的 `reason` 改名为 `trigger`，投影层映射回 IPC 的 `reason`，渲染层零改动。
- 失败场景的端到端测试必须 `settings.retry.enabled = false`，否则 backoff 把失败推到断言窗口之外；且 `fauxAssistantMessage('', { errorMessage })` **不产生**失败，必须让响应工厂 `throw`。
- `pnpm install` 为 1.5.0 在 `pnpm-workspace.yaml` 自动加了 `minimumReleaseAgeExclude`（新发布的包默认会被最小发布年龄策略挡住）。这一项必须提交，否则别人装不上。
