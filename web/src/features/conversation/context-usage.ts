/**
 * 上下文占用估算：把会话里最新的用量读数换算成“已用 tokens / 窗口百分比”。
 *
 * 数据来源只有两类，都来自 Durable 投影：
 *  - assistant / toolResult 消息上的 `usage`（该次请求的 token 消耗，含缓存读写）；
 *  - 当前模型在模型目录里的 `contextWindow`。
 *
 * 一次请求的 `input + cacheRead + cacheWrite + output` 就是那次请求结束时的上下文
 * 大小，和 Durable 判断压缩阈值时用的估算同一量级。之后新增的消息尚未计入，因此
 * 界面上把它当作“已用（近似）”，宁可低估也不虚构精度。
 */

export type ContextUsage = {
  /** 已用 tokens（最近一次请求的输入 + 缓存 + 输出）。 */
  usedTokens: number;
  /** 上下文窗口；未知时为 0。 */
  contextWindow: number;
  /** 0–100 的整数百分比；窗口未知时为 0。 */
  percent: number;
  /** 该读数来自哪条消息的时间戳，便于界面提示数据新鲜度。 */
  at?: number;
};

type UsageLike = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
};

type MessageLike = {
  role?: string;
  timestamp?: number;
  usage?: unknown;
};

function positive(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** 一次请求的上下文大小：四项相加；缺失时退回提供方给出的 totalTokens。 */
export function usageTokens(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const value = usage as UsageLike;
  const sum = positive(value.input)
    + positive(value.output)
    + positive(value.cacheRead)
    + positive(value.cacheWrite);
  return sum > 0 ? sum : positive(value.totalTokens);
}

/**
 * 取最新一条带用量读数的消息。流式输出时正在生成的消息也在其中，因此百分比会随
 * 回合推进刷新；没有任何读数（新会话或提供方不回传用量）时返回 null。
 */
export function contextUsage(
  messages: readonly MessageLike[] | undefined,
  contextWindow: number,
): ContextUsage | null {
  const window = positive(contextWindow);
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!message || typeof message !== 'object') continue;
    const tokens = usageTokens(message.usage);
    if (tokens <= 0) continue;
    return {
      usedTokens: tokens,
      contextWindow: window,
      percent: window > 0 ? Math.min(100, Math.round((tokens / window) * 100)) : 0,
      ...(Number.isFinite(Number(message.timestamp)) ? { at: Number(message.timestamp) } : {}),
    };
  }
  return null;
}

/** 紧凑的 token 文案：12.4k / 1.2M，界面标题与提示共用。 */
export function compactTokens(value: number): string {
  const tokens = Math.max(0, Math.round(Number(value) || 0));
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const thousands = tokens / 1_000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
  }
  return String(tokens);
}
