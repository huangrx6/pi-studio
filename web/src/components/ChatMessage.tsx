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

function ToolCluster({ calls, toolResults, busy }: { calls: ToolCallBlock[]; toolResults: Map<string, ChatMessage>; busy: boolean }) {
  return <div className={`tool-cluster ${calls.length === 1 ? 'is-single' : ''}`}>
    {calls.length > 1 && <div className="tool-cluster-head"><span className="tool-cluster-symbol"><Wrench /></span><span>执行轨迹</span><span className="tool-cluster-count">{calls.length}</span><span className="tool-cluster-line" /></div>}
    <div className="tool-cluster-body">{calls.map((call) => <ToolCall key={call.id} call={call} result={toolResults.get(call.id)} busy={busy} />)}</div>
  </div>;
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

function AssistantStep({ message, toolResults, busy }: { message: ChatMessage; toolResults: Map<string, ChatMessage>; busy: boolean }) {
  const nodes = [];
  for (let index = 0; index < message.content.length; index += 1) {
    const block = message.content[index];
    if (block.type === 'toolCall') {
      const calls = [block];
      while (index + 1 < message.content.length && message.content[index + 1].type === 'toolCall') {
        index += 1;
        calls.push(message.content[index] as ToolCallBlock);
      }
      nodes.push(<ToolCluster key={`tools-${block.id || index}`} calls={calls} toolResults={toolResults} busy={busy} />);
    } else if (block.type === 'thinking') {
      nodes.push(<Thinking block={block} key={`thinking-${index}`} />);
    } else if (block.type === 'text' && block.text) {
      nodes.push(<Markdown key={`text-${index}`}>{block.text}</Markdown>);
    } else if (block.type === 'image') {
      nodes.push(<img className="message-image" key={`image-${index}`} src={`data:${block.mimeType};base64,${block.data}`} alt="" />);
    }
  }
  return <div className="assistant-step">
    {nodes}
    {message.streaming && <span className="caret" />}
    {message.errorMessage && <div className="message-error">{message.errorMessage}</div>}
  </div>;
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export function AssistantTurnView({ messages, toolResults, busy }: { messages: ChatMessage[]; toolResults: Map<string, ChatMessage>; busy: boolean }) {
  const toolCount = messages.reduce((total, message) => total + message.content.filter((block) => block.type === 'toolCall').length, 0);
  const thinkingCount = messages.reduce((total, message) => total + message.content.filter((block) => block.type === 'thinking').length, 0);
  const live = busy && messages.some((message) => message.streaming);
  const latest = messages[messages.length - 1];
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
      {messages.map((message, index) => <AssistantStep key={message.timestamp ?? index} message={message} toolResults={toolResults} busy={busy} />)}
    </div>
  </div>;
}

export function ChatMessageView({ message }: { message: ChatMessage }) {
  if (message.role !== 'user') return null;
  const text = message.content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('\n');
  return <div className="message user"><div className="user-bubble">{text}<MessageImages blocks={message.content} /></div></div>;
}
