/**
 * 把 Pi Durable 的 `RunFailureReason` 翻成可读文案。
 * 1.5.0 把 `task_failed` / `submission.updated` 统一成 `pi.live.runFailure`，
 * 取值比旧版多；这里的每个分支都对应一个真实结局。
 */
export function submissionFailureText(reason?: string, detail?: unknown): string | undefined {
  if (!reason) return undefined;
  const detailText = typeof detail === 'string'
    ? detail
    : detail && typeof detail === 'object' && 'message' in detail
      ? String((detail as { message?: unknown }).message || '')
      : '';
  if (reason === 'no_model') {
    return '当前会话使用的模型没有加载到运行引擎。请重新选择模型后再发送。';
  }
  if (reason === 'model_error') {
    return detailText || '模型请求没有完成，请检查模型来源、凭据和网络后重试。';
  }
  if (reason === 'aborted') {
    return '已停止本轮运行。';
  }
  if (reason === 'reset') {
    return '上下文已重置，本轮没有生成回答。请重新发送。';
  }
  if (reason === 'nothing_to_answer') {
    return '当前上下文里没有需要回答的内容。';
  }
  if (reason === 'turn_limit') {
    return detailText
      ? `工具调用轮次达到上限（${detailText}），本轮已暂停。发送“继续”可接着完成。`
      : '工具调用轮次达到上限，本轮已暂停。发送“继续”可接着完成。';
  }
  if (reason === 'interrupted') {
    return '应用在模型回答时中断，重试次数已用尽。请重新发送。';
  }
  if (reason === 'restart_limit') {
    return '本轮运行连续中断次数过多，已终止。请重新发送后重试。';
  }
  if (reason === 'faulted') {
    return detailText || '运行任务异常终止，请重新发送后重试。';
  }
  if (reason === 'orphaned') {
    return '运行任务找不到可用的执行代码。重新打开会话后再试。';
  }
  return detailText || `本轮运行没有完成（${reason}）。`;
}
