# Pi Durable 依赖升级

Pi Studio 的执行、存储与模型接口依赖 Pi Durable 生态。升级时同时检查接口变化、持久化格式和真实应用行为。

## 依赖范围

以下五个直接依赖使用同一组精确版本，具体版本以根目录 `package.json` 与 `pnpm-lock.yaml` 为准：

| 包 | 主要职责 |
| --- | --- |
| `@earendil-works/pi-durable` | Harness、会话、任务、工具与持久化 |
| `@earendil-works/pi-ai` | 模型目录、消息与提供商接口 |
| `@earendil-works/chord` | 上下文与取消信号 |
| `@earendil-works/pi-mcp` | MCP 客户端与传输 |
| `@earendil-works/pi-telemetry` | 追踪与指标 |

## 升级步骤

1. 运行 `pnpm run upgrade:check`，读取当前版本与目标版本之间的上游变更记录。按实际使用的符号检查 `electron/main/`、`sdk/` 和测试，不仅依据变更标题判断兼容性。
2. 在隔离副本中同步更新相关依赖及锁文件，列出需要调整的导出、调用参数、事件、文档格式和存储行为。
3. 将依赖版本与对应适配一起修改，保持 Pi Durable 为执行事实来源，不保留已删除 API 的长期兼容分支。
4. 运行根目录 [AGENTS.md](../../AGENTS.md#验证) 中的完整检查，并验证示例扩展。
5. 使用隔离的 `PI_STUDIO_USER_DATA` 验证真实桌面会话、工具调用、停止与恢复、持久化重开；再检查涉及的 MCP、子智能体和扩展功能。
6. 将有效的接口约束补入测试，当前版本的用户可见变化记入 `.github/release-notes/`。持续维护契约与操作流程，不另积累一次性升级计划。

接口守卫参见 [Durable API 测试](../../tests/electron/durable-api-surface.test.cjs)；运行期验证还应覆盖 `tests/integration/`，避免仅依赖模拟对象。

## 数据与回退

升级可能改变 Durable 文档版本，即使 SQLite 表结构未变，旧依赖也不一定能读取新文档。验证必须使用独立数据目录。对真实数据升级前关闭应用并备份 Studio 数据根目录；回退时确认旧版能够读取数据，必要时恢复升级前的备份。

默认数据根目录是 `~/.pi-studio/`。`PI_STUDIO_USER_DATA` 可指定隔离目录，`PI_STUDIO_DB` 可单独指定数据库文件。不得操作旧版 `~/.pi` 数据。
