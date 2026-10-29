/**
 * 消息序列化：把 Pi SDK 的内部消息结构转成渲染进程能直接用的普通对象。
 *
 * 这是「主进程 → 渲染进程」唯一的数据出口，所有 IPC 里传来的消息都经过这里，
 * 好处是渲染进程不需要知道 Pi 的类结构，也方便以后做字段裁剪。
 */

const { parseAttachmentMarkers } = require('./attachment-markers.cjs');

/**
 * 去掉终端 ANSI 控制字符。
 * 扩展的 footer / 状态行来自 TUI 组件，可能带颜色转义，必须清理后再发给前端。
 */
function stripAnsi(value) {
  return String(value ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * 序列化消息内容块。
 * 只保留渲染进程认识的四种：text / image / thinking / toolCall。
 */
function serializeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && typeof block.data === 'string') {
      blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType || 'image/png' });
    } else if (block.type === 'thinking') {
      blocks.push({
        type: 'thinking',
        thinking: typeof block.thinking === 'string' ? block.thinking : '',
        ...(block.redacted ? { redacted: true } : {}),
      });
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: block.arguments && typeof block.arguments === 'object' ? block.arguments : {},
        ...(block.namespace ? { namespace: block.namespace } : {}),
      });
    }
  }
  return blocks;
}

/**
 * Tool results can carry large extension-owned objects. Subagent transcripts and
 * filesystem session paths stay in the main process; the renderer receives only
 * the compact metadata it needs to render an inline subagent result.
 */
function serializeSubagentDetails(details) {
  if (!details || typeof details !== 'object') return undefined;
  const results = Array.isArray(details.results)
    ? details.results.slice(0, 100).map((result) => ({
      index: result?.index,
      runId: result?.runId,
      agent: result?.agent,
      task: typeof result?.task === 'string' ? result.task.slice(0, 2_000) : '',
      context: result?.context,
      model: result?.model || result?.requestedModel,
      thinking: result?.thinking,
      usage: result?.usage,
      exitCode: result?.exitCode,
      error: typeof result?.error === 'string' ? result.error.slice(0, 2_000) : undefined,
      finalOutput: typeof result?.finalOutput === 'string' ? result.finalOutput.slice(0, 4_000) : undefined,
    }))
    : [];
  return {
    runId: details.runId,
    toolCallId: details.toolCallId,
    background: Boolean(details.background),
    context: details.context,
    results,
  };
}

/**
 * 序列化一条消息。
 * 返回 null 表示这条消息不需要展示（例如未知角色）。
 */
function serializeMessage(message) {
  if (!message || !['user', 'assistant', 'toolResult'].includes(message.role)) return null;
  const result = { role: message.role, content: serializeContent(message.content), timestamp: message.timestamp };

  if (message.role === 'user') {
    // 用户消息里可能夹带附件标记：拆出附件信息，正文只留文本
    const joined = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    const parsed = parseAttachmentMarkers(joined);
    if (parsed.attachments.length > 0) {
      const nonText = result.content.filter((block) => block.type !== 'text');
      result.content = [...(parsed.text ? [{ type: 'text', text: parsed.text }] : []), ...nonText];
      result.attachments = parsed.attachments;
    }
  }

  if (message.role === 'assistant') {
    result.stopReason = message.stopReason;
    result.errorMessage = message.errorMessage;
    result.model = message.responseModel || message.model;
    result.provider = message.provider;
    result.usage = message.usage;
    result.thinkingLevel = message.thinkingLevel;
  }

  if (message.role === 'toolResult') {
    result.toolCallId = message.toolCallId;
    result.toolName = message.toolName;
    result.isError = Boolean(message.isError);
    if (message.durationMs !== undefined) result.durationMs = message.durationMs;
    // todo 需要完整计划；subagent 只透传不含 session 路径的紧凑摘要。
    if (message.toolName === 'todo' && message.details) result.details = message.details;
    if ((message.toolName === 'subagent' || message.toolName === 'subagents') && message.details) {
      result.details = serializeSubagentDetails(message.details);
    }
  }

  return result;
}

/**
 * 过滤掉「已经被自动重试覆盖」的失败回复。
 *
 * 判断规则：一条 assistant 消息以 error 结束，但同一轮里后面又有成功的 assistant
 * 回复，就说明这条错误只是中间态，不必展示给用户。
 */
function visibleSessionMessages(messages) {
  return messages.filter((message, index) => {
    if (message.role !== 'assistant' || message.stopReason !== 'error' || !message.errorMessage) return true;
    let nextUser = messages.length;
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      if (messages[cursor].role === 'user') {
        nextUser = cursor;
        break;
      }
    }
    return !messages.slice(index + 1, nextUser).some((next) => next.role === 'assistant' && next.stopReason !== 'error');
  });
}

module.exports = { stripAnsi, serializeContent, serializeMessage, serializeSubagentDetails, visibleSessionMessages };
