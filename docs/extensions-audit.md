# Pi Studio 扩展与内置能力审查

本文记录 `0.0.3` 开发线上对扩展运行时、声明式 UI、MCP、Skill、权限和九个内置扩展的审查结果。审查目标是可靠加载、明确失败、可热更新、可撤销信任和资源可释放；它不等于对第三方 Node 代码的安全认证。

## 结论

- 九个内置扩展已经拆成独立贡献，使用与第三方扩展相同的 Durable registry、依赖、健康状态和卸载生命周期。
- `core` 与 `optional` 工具受保护，用户扩展不能通过同名工具替换权限守卫或可选能力。
- 项目扩展、项目 Skill 和外部路径默认按不可信输入处理；内容变化会使旧信任失效。
- Agent 扩展仍是受用户信任的本机 Node 代码。当前没有 OS 进程沙箱；需要强隔离时应使用容器、受限账户或系统沙箱。

## 内置扩展

| 扩展 | 层级 | 核心职责 | 主要保护与验证 | 当前边界 |
| --- | --- | --- | --- | --- |
| `builtin:durable-coding-tools` | system | 提供 Pi Durable 官方 `read`、`write`、`edit`、`bash` | 依赖权限守卫；工具身份不可被 `core`/`optional` 冲突静默覆盖；通过真实 Durable registry 测试 | 工具行为以 Pi Durable 1.4 为准 |
| `builtin:studio-filesystem-tools` | system | 提供工作区内的 `ls`、`find`、`grep` | realpath containment；文件、总字节、结果数量和行长度上限；`grep` 正则进入可终止 Worker | 静态扫描不是内容索引，超限会明确截断 |
| `builtin:studio-harness` | system | 组合编码身份、规则、工具说明、`AGENTS.md`、Skill、工作区和附加指令 | profile 校验与版本化；下一请求边界热刷新；工具 guidance 跟随实际工具集 | 不能保证与 Pi Coding Agent SDK 的模型输出逐次一致 |
| `builtin:studio-tool-search` | system | 为 deferred MCP 工具提供官方 `tool_search` | tool_search 按需加载；MCP namespace 工具选择；加载结果在后续请求使用 | 需要模型主动发现工具，不能保证每次任务都调用 |
| `builtin:studio-skills` | system | 把 Agent Skills 元数据注入 Prompt，正文按需读取 | Studio 项目优先、`.agents/skills` 互操作、YAML 校验、整目录指纹、项目显式信任、热重载 | 缺失 description 或解析失败的 Skill 会被跳过并报告诊断 |
| `builtin:studio-permissions` | core | 在 Durable `ToolTask` 前应用 `ask`、`smart`、`full` 策略 | 全局/工作区/会话继承；`deny > ask > allow`；模型、MCP、nested ToolTask 统一检查；符号链接越界和明显系统破坏命令硬拦截 | Bash 是保守静态分析，包装器、编译程序、动态路径等仍可能绕过 |
| `builtin:studio-subagents` | system | 通过 task-owned child conversation 创建子 Agent | 独立模型、thinking 和上下文；前台、后台、并行与链式子 Agent；工具白名单与父工具取交集；禁止递归；停止、等待、监督询问、取消传播、transcript 分页与归属校验 | 子 Agent 仍共享受信任的主进程执行边界，不是独立 OS 沙箱 |
| `builtin:studio-subagent-channel` | system | 提供 child-owned `contact_supervisor` 通道 | 只注入 Studio 创建的子会话；请求有数量与长度上限；父 Agent 通过 `subagent_supervisor` 回复 | 监督是异步协作协议，不代表前台批准本身会暂停整个子 Agent |
| `builtin:studio-metrics` | optional | 实时展示 TTFT、TPS、Token、成本、请求和任务阶段 | 使用官方 Pi AI/Durable telemetry；缓冲和订阅有界；内容无关；停用与关闭时释放 provider | 属于可选观测能力，不影响 Agent 执行正确性 |

## 扩展宿主

### 安装与发行

- 本地目录、ZIP、HTTPS、GitHub 和 registry 来源先进入 quarantine，再展示安装预览。
- 预览绑定 scope 与规范化工作区，显示源码、publisher、执行方式、权限差异、依赖、包摘要和内容树摘要。
- 权限扩张必须重新确认；同一版本内容不可变；降级只能通过保留版本回滚。
- 升级和回滚使用原子状态与活动指针；失败会恢复旧指针，并清理未激活暂存目录。
- 数据目录独立于版本代码；升级、回滚和默认卸载保留数据。
- SHA-256 提供完整性；可选 Ed25519 签名绑定扩展 ID、版本、发布者和内容树。首次见到发布者公钥时仍需用户核对指纹，本机 trust store 才能验证后续身份连续性。

### 信任与热加载

- 用户扩展安装后默认信任；项目扩展默认不信任。
- 项目扩展或 Skill 的完整目录内容变化会使旧信任失效，依赖者随之停止加载。
- 受管版本被直接修改时拒绝加载，而不是继续使用模块缓存。
- 安装、重载、完整性检查和关闭清理共用串行队列，避免并发替换 registry。
- 新对话和下一次消息提交前重新检查扩展完整性；正在进行的工具调用继续使用开始时取得的实现。

### 声明式 UI

- 23 种 block 只能表达语义结构、指标、图表、时间线、状态、表格、进度和 data view。
- 不接受 HTML、CSS、JavaScript、React、任意 IPC、像素、绝对定位或覆盖层。
- action 仅允许设置页、同扩展面板、填充 Prompt、复制、HTTPS URL 和同扩展命令。
- 内容从全局 palette 与 design tokens 取色和尺寸；未知字段、未知 block、未知 action 和超限数据直接报错。
- 实时 data view 只有在收到 subscription ID 后接受事件；会话、工作区或 source 变化会清空旧快照。

### MCP 与 Skill

- MCP entry/state 关闭幂等，client、transport、timer 和订阅有共享的 bounded cleanup。
- 旧数据库中的非安全远程 URL 在运行时再次校验；单个 MCP 失败不会阻断健康 server。
- stdio 只继承运行环境白名单，配置密钥不出现在 renderer DTO。
- Skill 只向 Prompt 注入名称、描述和路径；`/skill:name` 可显式加载，项目正文需要信任。

## 已解决问题

- 权限草稿预览此前没有使用当前未保存配置。
- 权限作用域达到容量上限后，新配置可能被旧数据挤出。
- 旧 SQLite 中的不安全 MCP URL 可能绕过编辑入口。
- 用户正则可阻塞 Electron 主进程。
- 配置保存成功但运行时热加载失败时，界面可能误报成功。
- 项目扩展在被直接修改后可能继续使用旧信任或旧模块。
- 受管扩展文件被篡改时，运行时没有在提交前拒绝。
- 项目扩展路径别名可能导致 macOS 上扫描结果重复或缺失。
- 扩展实时 data view 的未完成读取、订阅和清理可能泄漏。
- MCP 重连、断开和关闭之间的旧 client/timer 可能残留。

## 验证

当前门禁：

```sh
pnpm extension:schema
pnpm test
pnpm run build
node tools/cli/pi-studio-extension.mjs validate examples/extensions/agent-starter --scope user --json
git diff --check
```

`pnpm test` 当前覆盖 233 项 Node 契约、集成和回归测试。仍需在正式发布前单独执行桌面截图 QA、长时内存压力测试和 Windows 打包验证。
