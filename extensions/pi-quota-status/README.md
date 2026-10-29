# 额度状态

Pi Studio 官方扩展。它根据当前会话的模型来源，通过固定的 HTTPS 接口查询明确支持的套餐窗口、API Key 额度和账户余额。

## 支持来源

- OpenCode Go
- GLM Coding Plan（国内；支持 Pi 官方 `zai-coding-cn` 与常见 Studio 来源 ID `zhipu`、`zhipuai`、`bigmodel`、`bigmodel-cn`）
- MiniMax Token Plan（国内）
- Kimi Code
- DeepSeek API
- Kimi API（国内）
- SiliconFlow（国内）
- OpenRouter 当前 Key

## 安全边界

扩展只声明 `provider.credentials` 和精确的 `providerAccess`。每次查询通过 Studio 的只读 capability 读取当前 provider 的密钥，无法枚举其他 provider，无法写入、删除或迁移凭据。密钥不会写入扩展数据目录，也不会进入界面内容。

查询只使用代码中固定的 endpoint，不跟随重定向，不根据模型 ID 猜测套餐账户。网络错误、HTTP 401/403/429/5xx、异常百分比和未知币种会显示可理解的诊断。

## 刷新

详情与底部摘要共用同一次查询，避免两个视图互相中止请求。面板打开时查询一次，之后每 60 秒刷新；瞬时网络错误会在短时间内保留上次成功值并标记为过期。
