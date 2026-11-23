# 项目文档

这里保留当前开发与维护所需的 Markdown 文档。产品官网和在线使用手册的 HTML、CSS、JavaScript 与图片位于 [`website/`](../website/)。

| 目录 | 保留内容 |
| --- | --- |
| `architecture/` | [仓库结构](architecture/repository-layout.md) · [能力模块与依赖边界](architecture/capabilities.md) · [会话内容展示规则](architecture/conversation-content.md) · [内嵌浏览器与 AI 浏览器操控](architecture/browser.md) |
| `guides/` | [资源作用域、优先级与刷新](guides/resources.md) · [网络代理](guides/network-proxy.md) · [技能来源与安装](guides/skill-hub.md) · [模型来源额度监控](guides/provider-quota.md) |
| `extensions/` | [扩展协议](extensions/README.md) · [声明式 UI](extensions/ui.md) · [打包、分发与安装](extensions/distribution.md) |
| `maintenance/` | [Pi Durable 依赖升级](maintenance/dependency-upgrades.md) |
| `releases/` | [版本记录索引](releases/README.md)，详细发布说明维护在 `.github/release-notes/` |

开发环境和检查命令见根目录 [README](../README.md#从源码运行) 与 [AGENTS.md](../AGENTS.md)。新增文档应说明当前约定或可重复执行的流程，并更新此索引；过期计划和一次性审查记录通过 Git 历史查阅。
