# Toolkit Starter（插件示例）

本地安装示例，覆盖 **MCP + Skill + CLI** 三种 provides，不依赖市场。

```bash
# 校验
node sdk/cli/pi-studio-plugin.mjs validate examples/plugins/toolkit-starter --json

# 应用内：设置 → 插件 → 从目录安装
```

| provides | 内容 |
| --- | --- |
| MCP | `toolkit-demo` stdio 服务器，`toolkit_echo` 工具 |
| Skill | `toolkit-demo` 使用说明 |
| CLI | `bin/toolkit`（`pathEnv: true`） |
