import type { ContentBlock } from '../../types/chat-types';
import type { ConversationImage } from './ConversationImageGallery';

/** 拼出消息里的全部文本块（用换行分隔）；用户正文和工具结果共用这一逻辑。 */
export function textBlocks(blocks: ContentBlock[]): string {
  return blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
}

export function imagesFromBlocks(blocks: ContentBlock[]): ConversationImage[] {
  return blocks.flatMap((block): ConversationImage[] => block.type === 'image'
    ? [{ src: `data:${block.mimeType};base64,${block.data}` }]
    : []);
}

/** 毫秒时间戳格式化为 24 小时制 HH:mm；无时间戳时返回空串。 */
export function formatTime(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
