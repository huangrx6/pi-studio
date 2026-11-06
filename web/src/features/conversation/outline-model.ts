import type { ChatMessage } from '../../types/chat-types';

export type OutlineItem = { sourceIndex: number; text: string; timestamp?: number };
export type OutlineData = { items: OutlineItem[]; totalMessages: number };

/** 没有生成助手消息的请求尝试，在对应用户消息之后显示的说明。 */
export const NO_ANSWER_TEXT = '本轮没有生成助手消息。';

/** 取出消息内容里的纯文本块；separator 用于区分「按行拼接」和「按空格拼接」。 */
export function textOfBlocks(content: ChatMessage['content'], separator = '\n'): string {
  return content
    .filter((block): block is Extract<ChatMessage['content'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(separator);
}

/** 独立大纲暂时不可用时，用当前已加载窗口生成可用的局部大纲。 */
export function outlineFromMessages(messages: ChatMessage[], messageStart = 0): OutlineData {
  const items = messages.flatMap((message, index): OutlineItem[] => {
    if (message.role !== 'user') return [];
    return [{
      sourceIndex: message.sourceIndex ?? messageStart + index,
      text: textOfBlocks(message.content, ' ').replace(/\s+/g, ' ').trim() || '消息',
      timestamp: message.timestamp,
    }];
  });
  return { items, totalMessages: messageStart + messages.length };
}

/** 当前窗口底部附近的最后一条提问，用于初次打开会话时同步大纲位置。 */
export function lastLoadedOutlineIndex(data: OutlineData, messages: ChatMessage[]): number {
  const sourceIndexes = messages
    .map((message) => message.sourceIndex)
    .filter((value): value is number => typeof value === 'number');
  if (sourceIndexes.length === 0) return Math.max(0, data.items.length - 1);
  const loaded = new Set(sourceIndexes);
  for (let index = data.items.length - 1; index >= 0; index -= 1) {
    if (loaded.has(data.items[index].sourceIndex)) return index;
  }
  return 0;
}
