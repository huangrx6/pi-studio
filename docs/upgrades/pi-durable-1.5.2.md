# Pi Durable 1.5.0 → 1.5.2

2026-11-16 核对 npm，Studio 的五个直接依赖均已发布 1.5.2。五个包使用精确版本，锁文件里的 pi-codemode 和 pi-schema 也同步到 1.5.2。上游在 11 月 9 日发布 1.5.1，在 11 月 10 日发布 1.5.2。[1.5.1 发布记录](https://github.com/earendil-works/pi/releases/tag/v1.5.1) · [1.5.2 发布记录](https://github.com/earendil-works/pi/releases/tag/v1.5.2)

| 包 | 与 Studio 有关的变化 | 适配结论 |
| --- | --- | --- |
| pi-durable | 修复并行工具结束后任务偶尔停在等待态的问题。SQLite 按表批量提交。支持按会话配置压缩策略。 | 继续用现有 Harness、SQLite 和压缩配置。会话级压缩可以在有单独产品需求时启用。[Durable 更新记录](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/CHANGELOG.md) |
| pi-ai | Anthropic 官方端点可复用服务端消息线程，1.5.2 修复 OAuth 请求里的客户端版本。OpenAI 兼容接口在本轮未启用工具时，默认省略空工具数组。 | 关闭临时聊天和永久删除持久会话时，按 Durable 的 ProviderDoc 释放对应的提供商缓存。旧 LiteLLM 等代理若要求有工具历史就发送空数组，上游提供单模型选项 `compat.requiresToolsWithToolHistory`，Studio 当前的自定义模型编辑器未暴露该项。[AI 更新记录](https://github.com/earendil-works/pi/blob/v1.5.2/packages/ai/CHANGELOG.md) |
| chord | 根入口切换到 v2，移除 v1。可选的 React 绑定声明 React 19.3.0。 | Studio 直接使用的上下文入口仍可用。Studio 前端使用 React 18.3.1，未加载 Chord React 绑定，安装会报告可选对等依赖版本提示。[Chord 更新记录](https://github.com/earendil-works/pi/blob/v1.5.2/packages/chord/CHANGELOG.md) |
| pi-mcp | 改善大消息 stdio 传输、HTTP 响应体大小限制及子进程退出清理。新增管道传输和 OAuth 登录辅助接口。 | 本次沿用现有传输和凭据管理，现有调用直接获得传输修复。[MCP 更新记录](https://github.com/earendil-works/pi/blob/v1.5.2/packages/mcp/CHANGELOG.md) |
| pi-telemetry | 提高 span 时钟精度，转义追踪文本中的控制字符。 | 现有指标和上下文接口可继续使用。[Telemetry 更新记录](https://github.com/earendil-works/pi/blob/v1.5.2/packages/telemetry/CHANGELOG.md) |

## 验证

- 使用真实的两个版本、临时 SQLite 和模拟模型，在 1.5.0 创建会话并完成一轮问答，用 1.5.2 重新打开相同 ID，再完成一轮问答并读回两轮回答。此次升级无需 Studio 数据迁移。
- 运行真实 Durable 的流式投影、长任务、工具发现、子智能体、请求轨迹和存储重开测试。临时聊天的回归测试同时检查清理传入的是对应的提供商会话 ID。
- 模型端点使用测试提供商。本次未使用生产凭据发起计费请求，也未连接第三方代理验证其特定兼容选项。
