import { useEffect, useState } from 'react';
import { Brain, ChevronDown, CircleCheck, CircleX, FileText, LoaderCircle, Pencil, Search, Terminal, Wrench } from 'lucide-react';
import type { ChatMessage, ContentBlock, ToolCallBlock } from '../chat-types';
import { Markdown } from './Markdown';

function MessageImages({ blocks }: { blocks: ContentBlock[] }) {
  const images = blocks.filter((block) => block.type === 'image');
  if (images.length === 0) return null;
  return <div className="message-images">{images.map((block, index) => block.type === 'image' && <img key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="" />)}</div>;
}

function toolSummary(call: ToolCallBlock): string {
  const args = call.arguments ?? {};
  const values = [args.command, args.path, args.file_path, args.query, args.pattern, args.url, args.name, args.description];
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').slice(0, 100);
    if (Array.isArray(value) && value.length > 0) return value.map(String).join(' ').replace(/\s+/g, ' ').slice(0, 100);
  }
  return '';
}

function ToolIcon({ name }: { name: string }) {
  if (name === 'bash' || name === 'powershell') return <Terminal />;
  if (name === 'read') return <FileText />;
  if (name === 'grep' || name === 'find' || name === 'ls') return <Search />;
  if (name === 'edit' || name === 'write') return <Pencil />;
  return <Wrench />;
}

function toolTone(name: string): string {
  if (name === 'bash' || name === 'powershell') return 'tone-shell';
  if (name === 'read') return 'tone-read';
  if (name === 'grep' || name === 'find' || name === 'ls') return 'tone-search';
  if (name === 'edit' || name === 'write') return 'tone-edit';
  return 'tone-tool';
}

function ToolCall({ call, result, busy }: { call: ToolCallBlock; result?: ChatMessage; busy: boolean }) {
  const failed = Boolean(result?.isError);
  const done = Boolean(result);
  const summary = toolSummary(call);
  return <details className={`tool-call ${failed ? 'is-error' : ''} ${done ? 'is-done' : 'is-running'}`}>
    <summary>
      <span className={`tool-call-icon ${toolTone(call.name)}`}><ToolIcon name={call.name} /></span>
      <span className="tool-call-name">{call.name}</span>
      {summary && <span className="tool-call-summary">{summary}</span>}
      <span className="tool-call-status">{failed ? <><CircleX />失败</> : done ? <><CircleCheck />完成</> : <><LoaderCircle className={busy ? 'spin' : ''} />运行中</>}</span>
      <ChevronDown className="tool-call-chevron" />
    </summary>
    <div className="tool-call-body">
      <div className="tool-call-label">参数</div>
      <pre className="tool-call-args">{JSON.stringify(call.arguments, null, 2)}</pre>
      {result && <>
        <div className="tool-call-label">结果</div>
        <pre className={`tool-call-output ${failed ? 'is-error' : ''}`}>{result.content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('\n')}</pre>
        <MessageImages blocks={result.content} />
      </>}
    </div>
  </details>;
}

function Thinking({ block }: { block: Extract<ContentBlock, { type: 'thinking' }> }) {
  const preview = block.redacted ? '已隐藏' : block.thinking.replace(/\s+/g, ' ').trim().slice(0, 72);
  return <details className="thinking-block">
    <summary>
      <span className="thinking-symbol"><Brain /></span>
      <span className="thinking-title">{block.redacted ? '思考已隐藏' : '思考过程'}</span>
      {preview && <span className="thinking-preview">{preview}</span>}
      <ChevronDown className="thinking-chevron" />
    </summary>
    {!block.redacted && block.thinking && <div className="thinking-content"><Markdown>{block.thinking}</Markdown></div>}
  </details>;
}

type FlatBlock = { block: ContentBlock; key: string };
type ActivityEntry = { kind: 'thinking'; block: Extract<ContentBlock, { type: 'thinking' }> } | { kind: 'tool'; call: ToolCallBlock } | { kind: 'text'; text: string };

function formatTime(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function AssistantTurnView({ messages, toolResults, busy }: { messages: ChatMessage[]; toolResults: Map<string, ChatMessage>; busy: boolean }) {
  const live = busy && messages.some((message) => message.streaming);
  const [activityOpen, setActivityOpen] = useState(live);
  useEffect(() => { if (live) setActivityOpen(true); }, [live]);
  const flat: FlatBlock[] = messages.flatMap((message, messageIndex) => message.content.map((block, blockIndex) => ({ block, key: `${messageIndex}-${blockIndex}` })));
  let lastActivity = -1;
  flat.forEach((entry, index) => { if (entry.block.type === 'thinking' || entry.block.type === 'toolCall') lastActivity = index; });
  const activityBlocks = lastActivity >= 0 ? flat.slice(0, lastActivity + 1) : [];
  const responseBlocks = lastActivity >= 0 ? flat.slice(lastActivity + 1) : flat;
  const activity: ActivityEntry[] = activityBlocks.flatMap((entry): ActivityEntry[] => {
    if (entry.block.type === 'thinking') return [{ kind: 'thinking', block: entry.block }];
    if (entry.block.type === 'toolCall') return [{ kind: 'tool', call: entry.block }];
    if (entry.block.type === 'text' && entry.block.text.trim()) return [{ kind: 'text', text: entry.block.text }];
    return [];
  });
  const toolCount = messages.reduce((total, message) => total + message.content.filter((block) => block.type === 'toolCall').length, 0);
  const thinkingCount = messages.reduce((total, message) => total + message.content.filter((block) => block.type === 'thinking').length, 0);
  const latest = messages[messages.length - 1];
  const error = messages.find((message) => message.errorMessage)?.errorMessage;
  return <div className={`assistant-turn ${live ? 'is-live' : ''}`}>
    <div className="assistant-turn-rail"><span className="assistant-orb">π</span></div>
    <div className="assistant-turn-main">
      <div className="assistant-turn-head">
        <span className="assistant-turn-name">Pi</span>
        <span className="assistant-turn-status">{live ? '正在处理' : '已完成'}</span>
        <span className="assistant-turn-meta">
          {messages.length > 1 && <span><span className="turn-dot" />{messages.length} 步</span>}
          {toolCount > 0 && <span className="turn-metric-tools"><Wrench />{toolCount}</span>}
          {thinkingCount > 0 && <span className="turn-metric-thinking"><Brain />{thinkingCount}</span>}
        </span>
        {latest?.timestamp && <time>{formatTime(latest.timestamp)}</time>}
      </div>
      {activity.length > 0 && <details className="activity-drawer" open={activityOpen} onToggle={(event) => setActivityOpen(event.currentTarget.open)}>
        <summary>
          <span className="activity-symbol"><Wrench /></span>
          <span>执行轨迹</span>
          <span className="activity-summary">{toolCount} 次工具 · {thinkingCount} 次思考</span>
          <ChevronDown className="activity-chevron" />
        </summary>
        {activityOpen && <div className="activity-log">
          {activity.map((entry, index) => entry.kind === 'tool'
            ? <ToolCall key={`tool-${entry.call.id}-${index}`} call={entry.call} result={toolResults.get(entry.call.id)} busy={busy} />
            : entry.kind === 'thinking'
              ? <Thinking key={`thinking-${index}`} block={entry.block} />
              : <div className="activity-note" key={`note-${index}`}><Markdown>{entry.text}</Markdown></div>)}
        </div>}
      </details>}
      {responseBlocks.length > 0 && <div className="assistant-response">
        {lastActivity >= 0 && <div className="response-kicker">回复</div>}
        {responseBlocks.map((entry) => entry.block.type === 'text' && entry.block.text
          ? <Markdown key={entry.key}>{entry.block.text}</Markdown>
          : entry.block.type === 'image'
            ? <img className="message-image" key={entry.key} src={`data:${entry.block.mimeType};base64,${entry.block.data}`} alt="" />
            : null)}
        {live && <span className="caret" />}
      </div>}
      {!live && responseBlocks.length === 0 && error && <div className="message-error">{error}</div>}
      {live && responseBlocks.length === 0 && <span className="caret" />}
    </div>
  </div>;
}

export function ChatMessageView({ message }: { message: ChatMessage }) {
  if (message.role !== 'user') return null;
  const text = message.content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('\n');
  return <div className="message user"><div className="user-bubble">{text}<MessageImages blocks={message.content} /></div></div>;
}
