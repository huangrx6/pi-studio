/**
 * Project a Durable transcript message into the JSON-safe shape used by the
 * temporary-chat renderer. Persisted Studio conversations use the richer
 * conversation projection in durable-conversations.cjs.
 */

const { parseAttachmentMarkers } = require('./attachment-markers.cjs');

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
  }

  return result;
}

module.exports = { serializeMessage };
