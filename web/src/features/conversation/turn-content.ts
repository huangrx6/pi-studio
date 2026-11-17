import type { ChatMessage, ContentBlock, ToolCallBlock } from '../../types/chat-types';
import type { ConversationImage } from './ConversationImageGallery';
import { imagesFromBlocks } from './message-content.ts';
import { webAction, webSources } from './web-sources.ts';

type ThinkingBlock = Extract<ContentBlock, { type: 'thinking' }>;
type Turn = { kind: 'user'; message: ChatMessage } | { kind: 'assistant'; messages: ChatMessage[] };

export function groupTranscript(messages: ChatMessage[]) {
  const turns: Turn[] = [];
  const results = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role === 'toolResult') {
      if (message.toolCallId) results.set(message.toolCallId, message);
    } else if (message.role === 'user') {
      turns.push({ kind: 'user', message });
    } else {
      const previous = turns.at(-1);
      if (previous?.kind === 'assistant') previous.messages.push(message);
      else turns.push({ kind: 'assistant', messages: [message] });
    }
  }
  return { turns, results };
}

export type ActivityEntry = { key: string; live: boolean } & (
  | { kind: 'tool'; call: ToolCallBlock }
  | { kind: 'thinking'; block: ThinkingBlock }
);

type Segment = { key: string } & (
  | { kind: 'text'; text: string }
  | { kind: 'images'; images: ConversationImage[] }
  | { kind: 'tool-images'; callId: string; images: ConversationImage[] }
  | { kind: 'activity'; entries: ActivityEntry[] }
);

export function activityKind(entry: ActivityEntry) {
  if (entry.kind === 'thinking') return 'thinking';
  const web = webAction(entry.call);
  if (web) return web;
  if (/^(?:generate_image|image_generation|imagegen|text_to_image)$/.test(entry.call.name.split('__').at(-1) || '')) return 'image';
  switch (entry.call.name) {
    case 'read': case 'grep': case 'find': case 'ls': return 'explore';
    case 'write': return 'write';
    case 'edit': return 'edit';
    case 'bash': case 'powershell': return 'command';
    case 'subagent': case 'subagent_stop': case 'subagent_supervisor': case 'bg_wait': return 'agent';
    default: return 'other';
  }
}

/** Prose and visible artifacts are reading boundaries. Tool calls stay paired by ID,
 * even if parallel results arrive in reverse order or are still outstanding. */
export function buildTurnContent(messages: ChatMessage[], results: Map<string, ChatMessage>, live: boolean) {
  const blocks = messages.flatMap((message, i) => message.content.map((block, j) => ({ key: i + '-' + j, block })));
  const last = [...blocks].reverse().find(({ block }) => block.type !== 'text' || block.text.trim());
  const segments: Segment[] = [];
  const calls: ToolCallBlock[] = [];
  let activeTool = false;
  let answer: string[] = [];
  for (const { key, block } of blocks) {
    const previous = segments.at(-1);
    if (block.type === 'text') {
      if (block.text.trim()) {
        segments.push({ kind: 'text', key, text: block.text });
        answer.push(block.text);
      }
    } else if (block.type === 'image') {
      const image = { src: 'data:' + block.mimeType + ';base64,' + block.data };
      if (previous?.kind === 'images') previous.images.push(image);
      else segments.push({ kind: 'images', key, images: [image] });
    } else if (block.type === 'thinking' || block.type === 'toolCall') {
      const entry: ActivityEntry = block.type === 'toolCall'
        ? { kind: 'tool', key, call: block, live: live && !results.has(block.id) }
        : { kind: 'thinking', key, block, live: live && key === last?.key };
      if (entry.kind === 'thinking' && !entry.live && !entry.block.redacted && !entry.block.thinking.trim()) continue;
      answer = [];
      if (previous?.kind === 'activity') previous.entries.push(entry);
      else segments.push({ key, kind: 'activity', entries: [entry] });
      if (entry.kind === 'tool') {
        calls.push(entry.call);
        activeTool ||= entry.live;
        const result = results.get(entry.call.id);
        const images = result && imagesFromBlocks(result.content);
        if (images?.length) segments.push({ key: key + '-output', kind: 'tool-images', callId: entry.call.id, images });
      }
    }
  }
  return { segments, activeTool, lastBlock: last?.block, answerText: answer.join('\n\n').trim(), sources: webSources(calls, results) };
}
