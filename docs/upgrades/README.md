# Pi Durable 升级同步流程

Pi Studio 的执行语义由 `@earendil-works/pi-durable` 提供。上游按周发版、**每个 minor 都带破坏性变更**（截至 1.5.0 尚无 major 版本，1.x 内部直接改 API），所以升级不是"改版本号"，而是一次有固定步骤的迁移。

这份文档是**流程**；每次具体升级在 `docs/upgrades/` 下写一份实例文档，例如 [`pi-durable-1.5.0.md`](./pi-durable-1.5.0.md)。

## 依赖边界

Studio 直接依赖 5 个同版本号发布的上游包，**必须整体升级，不可混版**：

| 包 | Studio 用法 | 升级敏感度 |
|---|---|---|
| `pi-durable` | Harness、Session、任务、文档、工具、存储 | 高（核心契约） |
| `pi-ai` | 模型目录、消息与用量类型 | 高（`Type` 已移除，见 1.5.0） |
| `chord` | 只有 `BACKGROUND_CONTEXT`、`withAbortSignal` | 低 |
| `pi-mcp` | `McpClient`、传输层、`toLlmContent` | 低 |
| `pi-telemetry` | `NOOP_TELEMETRY_CONTEXT`、metrics、propagation | 低 |

`package.json` 中全部使用**精确版本号**（无 `^`），请保持不变，以便复现构建。

## 每次升级的固定步骤

### 1. 发现与初筛（不改代码）

```sh
node tools/upgrades/check-durable.mjs
```

输出当前锁定版本、npm `latest`、以及两者之间的 CHANGELOG 条目。上游 changelog 是权威依据，但**不要只看分类**：`Breaking Changes` 一节里的每一条都要在代码里搜到对应位置，判断是否命中。

### 2. 影响面盘点

用第 1 步的具体符号去搜，而不是猜：

```sh
# 被删除或改名的导出
grep -rn "watchEvents\|subscribeCommits\|taskGraph\|retryTask" electron tools tests

# 被移除的再导出（历史上 pi-durable 与 pi-ai 都曾再导出 TypeBox）
grep -rn "piAi\.Type\|durable\.Type\|Type\.Object" electron tools tests extensions examples
```

把结果写进实例文档的"影响面"表，标注 **文件:行号 / 属于哪个阶段 / 是否阻断**。

### 3. 隔离副本实测（关键步骤）

单元测试大量使用 mock，**抓不到运行期契约变化**。1.5.0 删除 `watchEvents()` 时，`tests/electron/temporary-chat.test.cjs` 依然全绿，因为它的 mock 自己声明了 `watchEvents`。

所以每次升级都要在一个干净副本上实测：

```sh
SCRATCH=$(mktemp -d)
git archive HEAD | tar -x -C "$SCRATCH"
cd "$SCRATCH"
# 改 package.json 版本
pnpm install --no-frozen-lockfile
pnpm test
```

记录 `通过/失败` 数量作为基线。**这个数字会低估真实工作量**，它代表"测试能抓到的部分"，用于界定阶段 3 的回归范围，不是完成标准。

### 4. 分阶段落地

固定四个阶段，每个阶段独立可合、可回滚：

| 阶段 | 内容 | 是否升级依赖 |
|---|---|---|
| 0 | 护栏：API 面守卫测试、升级检查脚本、文档修正 | 否 |
| 1 | 解耦：把已移除的上游再导出换成 Studio 自有实现 | 否 |
| 2 | 切换：新 API 接线 + 升级依赖（原子） | 是 |
| 3 | 回归：手工 QA、文档与示例更新、降级预案 | 否 |

原则：

- **能在旧版本落地的，先落地**。阶段 0/1 在旧版本上跑通并合入，让阶段 2 的 diff 只剩语义切换。
- **阶段 2 不可分割**。改了版本号之后 `piAi.Type` 立刻是 `undefined`，任何"先升版本再慢慢改"的中间态都是全站崩溃。
- 不以"测试全绿"作为阶段 2 的验收终点，而是"测试全绿 + 手工跑通一条真实会话"。

### 5. 升级后固化

- 在实例文档末尾记录：实际耗时、额外发现的坑、上游 changelog 没写的坑。
- 若某个坑可以写成测试，补进 `tests/electron/durable-api-surface.test.cjs`。
- 更新本文件的依赖表（若用法变化）。

## 护栏清单（应由测试长期守住）

1. **API 面守卫**：`tests/electron/durable-api-surface.test.cjs` 断言 Studio 依赖的每个导出/方法存在。上游删掉任何一项，CI 立刻红，而不是等运行时。
2. **Schema 等价**：`tests/electron/tool-schema.test.cjs` 用冻结的 fixture 断言工具参数 schema 的输出逐字节稳定。工具 schema 直接进入模型请求，静默变化会改变模型行为。
3. **视图投影**：`tests/electron/durable-view.test.cjs` 用 fixture 覆盖 `ConversationView → Studio 事件` 的映射。这是 1.5.0 迁移最容易出错、也最不容易被现有测试覆盖的部分。

## 降级风险（每次升级前确认）

Studio 的 SQLite schema 由 Durable 管理。**SQLite 表结构可能不变，但文档版本会变**：

- 1.5.0 把 `pi.live` 从 version 1 升到 version 3（新增必填 `run.turns`），SQLite 表结构仍是 version 2。
- 旧版 Durable 读到更高版本的文档且没有 `migrate` 时，无法按旧定义解读。

结论：**一旦用新版本跑过真实会话，就不能简单回退到旧版本**。回滚必须先恢复升级前的数据库快照。

数据库位置：

```
app.getPath('userData')/pi-studio.sqlite
# macOS 通常为 ~/Library/Application Support/Pi Studio/pi-studio.sqlite
# 可用环境变量 PI_STUDIO_DB 覆盖
```

升级前请关闭应用并复制该文件。

## 不做的事

- 不写"同时兼容新旧 Durable"的运行时开关。两套投影逻辑并存会让问题无法定位，且与仓库"不留死回退路径"的约定冲突。
- 不为已删除的上游导出写长期 shim。仅在必要处补一次性的适配（例如下文的工具 schema 构造器），并注明它替代的是什么。
- 不跳版本。逐 minor 升级，每次只消化一个 changelog。
