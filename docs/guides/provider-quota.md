# 模型来源额度监控

在「设置 → 模型配置 → 编辑来源」中开启额度监控。填写厂商提供的 GET JSON 接口，选择认证方式，然后点击「读取接口字段」配置显示项。需要启用额度状态扩展。

## 认证方式

所有认证方式都使用该模型来源已保存的 API Key；原始凭据只在主进程中读取和发送。接口地址里不要粘贴密钥。

| 方式 | 请求中的位置 | 常见用途 |
| --- | --- | --- |
| 无需凭据 | 不发送密钥 | 无认证的本地统计接口 |
| Bearer | `Authorization: Bearer <key>` | DeepSeek、OpenRouter 等 |
| 原始 Authorization | `Authorization: <key>` | BigModel Coding Plan 额度查询 |
| x-api-key | `x-api-key: <key>` | Anthropic 等 |
| api-key | `api-key: <key>` | Azure 等 |
| x-goog-api-key | `x-goog-api-key: <key>` | Google API |
| 自定义请求头 | 指定请求头名，值为密钥 | `Ocp-Apim-Subscription-Key`、`X-Auth-Token` 等 |
| 查询参数 | 指定参数名，主进程编码并附加密钥 | 要求 `key` 等查询参数的接口 |

附加请求头支持 `anthropic-version`、`anthropic-beta`、`openai-organization`、`openai-project`、`x-goog-user-project` 和 `new-api-user`。这些字段只保存公开版本、组织、项目或用户标识，不能填写凭据。

支持一种认证传递方式不代表对应厂商提供余额查询接口。Anthropic 等用量接口可能要求管理员密钥；OAuth 登录续期、云平台动态请求签名，以及需要 Cookie 的控制台接口不由此表单处理。

## BigModel Coding Plan

- GET 地址：`https://open.bigmodel.cn/api/monitor/usage/quota/limit`
- 认证：**来源 API Key · 原始 Authorization**
- 显示格式：**百分比（0–100）**，单位留空。

返回数据含 `data.limits` 数组时，可以按周期匹配，避免数组顺序变化：

| 显示名称 | 字段路径 |
| --- | --- |
| 5 小时已用 | `data.limits[unit=3&number=5].percentage` |
| 本周已用 | `data.limits[unit=6&number=1].percentage` |

按实际响应选择字段；如果账户没有某个周期，不要添加对应映射。`percentage` 是已用比例，Coding Plan 额度也不是人民币账户余额。HTTP 200 中的 `success: false` 会按接口失败处理，不显示为有效额度。

## 厂商资料

- [智谱官方额度查询插件](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs)：额度接口与原始 Authorization。
- [DeepSeek 余额接口](https://api-docs.deepseek.com/api/get-user-balance/)：Bearer 认证。
- [OpenRouter 额度接口](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)：Bearer 认证，该接口要求管理密钥。
- [Anthropic 用量接口](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)：管理员密钥及版本请求头。
- [Google API Key](https://ai.google.dev/gemini-api/docs/api-key)：`x-goog-api-key`。
- [Azure API 认证](https://learn.microsoft.com/en-ca/azure/api-management/api-management-authenticate-authorize-azure-openai)：`api-key`。
- [Azure API Management 订阅密钥](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-create-subscriptions)：订阅密钥认证。
