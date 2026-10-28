import { Brain, ChevronDown, CircleCheck, CircleX, LoaderCircle, Wrench } from 'lucide-react';
import type { ChatMessage, ContentBlock, ToolCallBlock } from '../chat-types';
import { Markdown } from './Markdown';

function imageBlocks(blocks: ContentBlock[]) {
  return blocks.filter((block) => block.type === 'image');
}

function MessageImages({ blocks }: { blocks: ContentBlock[] }) {
  const images = imageBlocks(blocks);
  if (images.length === 0) return null;
  return <div className="message-images">{images.map((block, index) => block.type === 'image' && <img key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="" />)}</div>;
}

function toolSummary(call: ToolCallBlock): string {
  const args = call.arguments ?? {};
  const values = [args.command, args.path, args.file_path, args.query, args.pattern, args.url, args.name, args.description];
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').slice(0, 90);
    if (Array.isArray(value) && value.length > 0) return value.map(String).join(' ').replace(/\s+/g, ' ').slice(0, 90);
  }
  return '';
}

function ToolCall({ call, result, busy }: { call: ToolCallBlock; result?: ChatMessage; busy: boolean }) {
  const failed = Boolean(result?.isError);
  const done = Boolean(result);
  const summary = toolSummary(call);
  return <details className={`tool-call ${failed ? 'is-error' : ''} ${done ? 'is-done' : 'is-running'}`}>
    <summary>
      <span className="tool-call-icon"><Wrench /></span>
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
  return <details className="thinking-block">
    <summary><Brain /><span>{block.redacted ? '思考内容已隐藏' : '思考过程'}</span><ChevronDown /></summary>
    {!block.redacted && block.thinking && <div className="thinking-content"><Markdown>{block.thinking}</Markdown></div>}
  </details>;
}

export function ChatMessageView({ message, toolResults, busy }: { message: ChatMessage; toolResults: Map<string, ChatMessage>; busy: boolean }) {
  if (message.role === 'user') {
    const text = message.content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('\n');
    return <div className="message user"><div className="user-bubble">{text}<MessageImages blocks={message.content} /></div></div>;
  }

  if (message.role === 'toolResult') return null;

  return <div className="message assistant">
    <div className="assistant-content">
      {message.content.map((block, index) => {
        if (block.type === 'text') return block.text ? <Markdown key={index}>{block.text}</Markdown> : null;
        if (block.type === 'thinking') return <Thinking block={block} key={index} />;
        if (block.type === 'toolCall') return <ToolCall key={block.id || index} call={block} result={toolResults.get(block.id)} busy={busy} />;
        if (block.type === 'image') return <img className="message-image" key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="" />;
        return null;
      })}
      {message.streaming && <span className="caret" />}
      {message.errorMessage && <div className="message-error">{message.errorMessage}</div>}
    </div>
  </div>;
}
