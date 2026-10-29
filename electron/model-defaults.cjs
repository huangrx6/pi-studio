/** 模型引用统一为标准 `provider/model` 字符串。 */
function normalizedModelRef(value) {
  return typeof value === 'string' && value.includes('/') ? value : '';
}

/**
 * 启动时选择 Studio 的默认模型。
 *
 * 优先级：调试环境变量 > Pi settings.json > Studio 旧配置 > 内置兜底。
 * Pi settings.json 是终端与桌面端共享的默认来源；Studio 旧配置只用于 Pi
 * 尚未写入默认模型时的兜底。
 */
function resolveStartupModelRef({ environment, terminal, stored, fallback }) {
  return normalizedModelRef(environment)
    || normalizedModelRef(terminal)
    || normalizedModelRef(stored)
    || fallback;
}

module.exports = { normalizedModelRef, resolveStartupModelRef };
