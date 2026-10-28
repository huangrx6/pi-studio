import { useEffect, useState } from 'react';
import { Activity, Brain, ChevronDown, CircleCheck, CircleX, FileText, LoaderCircle, Pencil, Search, Terminal, Wrench } from 'lucide-react';
import type { ChatMessage, ContentBlock, ToolCallBlock } from '../chat-types';
import { AttachmentIcon, attachmentVisual } from './AttachmentIcon';
import { Markdown } from './Markdown';

function MessageImages({ blocks }: { blocks: ContentBlock[] }) {
  const images = blocks.filter((block) => block.type === 'image');
  if (images.length === 0) return null;
  return <div className="message-images">{images.map((block, index) => block.type === 'image' && <img key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="" />)}</div>;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function toolSummary(call: ToolCallBlock): string {
  const args = call.arguments ?? {};
  const values = [args.command, args.path, args.file_path, args.query, args.pattern, args.url, args.name, args.description];
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').slice(0, 105);
    if (Array.isArray(value) && value.length > 0) return value.map(String).join(' ').replace(/\s+/g, ' ').slice(0, 105);
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

function formatTime(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

type ToolEntry = { kind: 'tool'; call: ToolCallBlock };
type ThinkingEntry = { kind: 'thinking'; block: Extract<ContentBlock, { type: 'thinking' }> };
type TextEntry = { kind: 'text'; text: string };
type ActivityEntry = ToolEntry | ThinkingEntry | TextEntry;
type FlatBlock = { block: ContentBlock; key: string };

function ActivityTool({ call, result, busy }: { call: ToolCallBlock; result?: ChatMessage; busy: boolean }) {
  const failed = Boolean(result?.isError);
  const done = Boolean(result);
  const summary = toolSummary(call);
  return <details className={`activity-tool ${failed ? 'is-error' : ''} ${done ? 'is-done' : 'is-running'}`}>
    <summary>
      <span className="activity-tool-name">{call.name}</span>
      {summary && <span className="activity-tool-summary">{summary}</span>}
      <span className="activity-tool-status">{failed ? <><CircleX />失败</> : done ? <><CircleCheck />完成</> : <><LoaderCircle className={busy ? 'spin' : ''} />运行中</>}</span>
      <ChevronDown className="activity-tool-chevron" />
    </summary>
    <div className="activity-tool-body">
      <div className="activity-tool-label">参数</div>
      <pre className="activity-tool-code">{JSON.stringify(call.arguments, null, 2)}</pre>
      {result && <>
        <div className="activity-tool-label">结果</div>
        <pre className={`activity-tool-code ${failed ? 'is-error' : ''}`}>{result.content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('\n')}</pre>
        <MessageImages blocks={result.content} />
      </>}
    </div>
  </details>;
}

function ActivityThinking({ block }: { block: Extract<ContentBlock, { type: 'thinking' }> }) {
  const preview = block.redacted ? '思考内容已隐藏' : block.thinking.replace(/\s+/g, ' ').trim().slice(0, 110);
  return <details className="activity-thinking">
    <summary>
      <span className="activity-thinking-label">思考</span>
      {preview && <span className="activity-thinking-preview">{preview}</span>}
      <ChevronDown className="activity-thinking-chevron" />
    </summary>
    {!block.redacted && block.thinking && <div className="activity-thinking-body"><Markdown>{block.thinking}</Markdown></div>}
  </details>;
}

function ActivityNode({ entry }: { entry: ActivityEntry }) {
  if (entry.kind === 'thinking') return <span className="activity-node is-thinking"><Brain /></span>;
  if (entry.kind === 'tool') return <span className={`activity-node is-tool ${toolTone(entry.call.name)}`}><ToolIcon name={entry.call.name} /></span>;
  return <span className="activity-node is-note" />;
}

function activityColor(entry: ActivityEntry): string {
  if (entry.kind === 'thinking') return 'is-thinking';
  if (entry.kind === 'tool') return toolTone(entry.call.name);
  return 'is-note';
}

export function AssistantTurnView({ messages, toolResults, busy, id, retry }: { messages: ChatMessage[]; toolResults: Map<string, ChatMessage>; busy: boolean; id?: string; retry?: { attempt: number; maxAttempts: number; errorMessage?: string } }) {
  const live = Boolean(retry) || (busy && messages.some((message) => message.streaming));
  const failed = !live && messages.some((message) => message.errorMessage);
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
  return <div id={id} className={`assistant-turn ${live ? 'is-live' : ''} ${retry ? 'is-retrying' : ''} ${failed ? 'has-error' : ''}`}>
    <div className="assistant-turn-rail"><span className="assistant-orb">π</span></div>
    <div className="assistant-turn-main">
      <div className="assistant-turn-head">
        <span className="assistant-turn-name">Pi</span>
        <span className="assistant-turn-status" title={retry?.errorMessage}>{retry ? `重试中 ${retry.attempt}/${retry.maxAttempts}` : failed ? '失败' : live ? '正在处理' : '已完成'}</span>
        <span className="assistant-turn-meta">
          {messages.length > 1 && <span><span className="turn-dot" />{messages.length} 步</span>}
          {toolCount > 0 && <span className="turn-metric-tools"><Wrench />{toolCount}</span>}
          {thinkingCount > 0 && <span className="turn-metric-thinking"><Brain />{thinkingCount}</span>}
        </span>
        {latest?.timestamp && <time>{formatTime(latest.timestamp)}</time>}
      </div>
      {activity.length > 0 && <details className="activity-drawer" open={activityOpen} onToggle={(event) => setActivityOpen(event.currentTarget.open)}>
        <summary>
          <span className="activity-symbol"><Activity /></span>
          <span className="activity-title">执行轨迹</span>
          <span className="activity-pulse" aria-hidden="true">{activity.slice(0, 24).map((entry, index) => <i key={index} className={activityColor(entry)} />)}</span>
          <span className="activity-summary">{toolCount} 工具 · {thinkingCount} 思考</span>
          <ChevronDown className="activity-chevron" />
        </summary>
        {activityOpen && <div className="activity-log">
          {activity.map((entry, index) => <div className={`activity-line is-${entry.kind}`} key={`${entry.kind}-${index}`} style={{ animationDelay: `${Math.min(index, 14) * 24}ms` }}>
            <div className="activity-gutter"><ActivityNode entry={entry} /></div>
            <div className="activity-content">
              {entry.kind === 'tool' && <ActivityTool call={entry.call} result={toolResults.get(entry.call.id)} busy={busy} />}
              {entry.kind === 'thinking' && <ActivityThinking block={entry.block} />}
              {entry.kind === 'text' && <div className="activity-note"><Markdown>{entry.text}</Markdown></div>}
            </div>
          </div>)}
        </div>}
      </details>}
      {responseBlocks.length > 0 && <div className="assistant-response">
        {responseBlocks.map((entry) => entry.block.type === 'text' && entry.block.text
          ? <Markdown key={entry.key}>{entry.block.text}</Markdown>
          : entry.block.type === 'image'
            ? <img className="message-image" key={entry.key} src={`data:${entry.block.mimeType};base64,${entry.block.data}`} alt="" />
            : null)}
        {live && <span className="caret" />}
      </div>}
      {!live && error && <div className="message-error">{error}</div>}
      {live && responseBlocks.length === 0 && <span className="caret" />}
    </div>
  </div>;
}

export function ChatMessageView({ message, id }: { message: ChatMessage; id?: string }) {
  if (message.role !== 'user') return null;
  const text = message.content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('\n');
  return <div id={id} className="message user"><div className="user-bubble">
    {text && <div className="user-text">{text}</div>}
    {message.attachments?.map((attachment) => {
      const visual = attachmentVisual(attachment.name, attachment.mime);
      return <div className="attachment-card" key={attachment.path} title={attachment.path}>
        <AttachmentIcon name={attachment.name} mime={attachment.mime} />
        <span className="attachment-main"><strong>{attachment.name}</strong><span>{formatBytes(attachment.bytes)}{attachment.lines ? ` · ${attachment.lines.toLocaleString('zh-CN')} 行` : ''}</span></span>
        <span className={`attachment-kind ${visual.tone}`}>{visual.label.toUpperCase()}</span>
      </div>;
    })}
    <MessageImages blocks={message.content} />
  </div></div>;
}
