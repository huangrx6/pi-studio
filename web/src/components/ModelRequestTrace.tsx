import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Image as ImageIcon, Search, Send, Wrench } from 'lucide-react';
import type { RequestTrace, RequestTraceContentBlock, RequestTraceMessage } from '../types/chat-types';
import type { StepDisplay } from '../lib/preferences';
import '../styles/request-trace.css';

function requestRoleLabel(role: string): string {
  if (role === 'system') return '系统提示词';
  if (role === 'user') return '用户消息';
  if (role === 'assistant') return '助手消息';
  if (role === 'toolResult' || role === 'tool') return '工具结果';
  if (role === 'trace') return '快照提示';
  return role || '消息';
}

function requestMessagePreview(message: RequestTraceMessage): string {
  let text = '';
  for (const block of message.content) {
    if (text.length >= 150) break;
    const part = (() => {
      if (block.type === 'text') return block.text;
      if (block.type === 'thinking') return block.thinking;
      if (block.type === 'toolCall') return block.name;
      if (block.type === 'image') return `[图片 ${block.mimeType}]`;
      return '';
    })();
    text += ' ' + (part || '').slice(0, 150);
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 150);
}

function requestBlockValue(block: RequestTraceContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'thinking') return block.thinking;
  if (block.type === 'toolCall') return JSON.stringify(block.arguments, null, 2);
  if ('value' in block) return JSON.stringify(block.value, null, 2);
  return '';
}

function RequestTraceMessageView({ message }: { message: RequestTraceMessage }) {
  const preview = requestMessagePreview(message);
  const [open, setOpen] = useState(false);
  return <details className={`request-message is-${message.role}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="request-message-role">{requestRoleLabel(message.role)}</span>
      {preview && <span className="request-message-preview">{preview}</span>}
      {message.truncated && <span className="request-message-truncated">已截断</span>}
      <ChevronDown className="request-message-chevron" />
    </summary>
    {open && <div className="request-message-body">
      {message.content.map((block, index) => {
        if (block.type === 'image') {
          return <div className="request-image-placeholder" key={index}>
            <ImageIcon />
            <span>{block.mimeType}</span>
            <span>{formatRequestSize(block.bytes)} B</span>
            <small>图片数据未复制到请求轨迹</small>
          </div>;
        }
        if (block.type === 'toolCall') {
          return <div className="request-tool-call" key={index}>
            <div className="request-tool-call-head"><Wrench /><span>{block.name}</span></div>
            <pre>{requestBlockValue(block)}</pre>
          </div>;
        }
        const value = requestBlockValue(block);
        return value ? <pre className={`request-block is-${block.type}`} key={index}>{value}</pre> : null;
      })}
    </div>}
  </details>;
}

function formatRequestSize(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M`;
  if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)}K`;
  return String(chars);
}

const PAGE_SIZE = 16;
type InspectorTab = 'system' | 'context' | 'tools';

function RequestInspector({ trace }: { trace: RequestTrace }) {
  const [tab, setTab] = useState<InspectorTab>('context');
  const [query, setQuery] = useState('');
  // null means the newest page. Older context remains accessible in chronological order.
  const [page, setPage] = useState<number | null>(null);
  const system = useMemo(() => trace.messages.filter(message => message.role === 'system'), [trace.messages]);
  const context = useMemo(() => trace.messages.filter(message => message.role !== 'system'), [trace.messages]);
  const messages = tab === 'system' ? system : context;
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return messages;
    return messages.filter(message => requestRoleLabel(message.role).includes(needle)
      || message.content.some(block => `${block.type === 'toolCall' ? block.name : block.type === 'image' ? block.mimeType : ''} ${requestBlockValue(block)}`.toLocaleLowerCase().includes(needle)));
  }, [messages, query]);
  const tools = useMemo(() => trace.tools.filter(tool => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [trace.tools, query]);
  const total = tab === 'tools' ? tools.length : filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page ?? (tab === 'context' ? pages - 1 : 0), pages - 1);
  const start = currentPage * PAGE_SIZE;
  const changeTab = (value: InspectorTab) => { setTab(value); setQuery(''); setPage(null); };
  const counts = { system: system.length, context: context.length, tools: trace.tools.length };
  return <div className="request-inspector">
    <div className="request-inspector-toolbar">
      <div className="request-inspector-tabs" aria-label="请求内容">
        {([['system', '系统提示词'], ['context', '上下文'], ['tools', '工具定义']] as const).map(([value, label]) =>
          <button type="button" key={value} aria-pressed={tab === value} onClick={() => changeTab(value)}>{label}<span>{counts[value]}</span></button>)}
      </div>
      <label className="request-inspector-search"><Search /><input aria-label="搜索请求内容" placeholder="搜索内容" value={query}
        onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
    </div>
    <div className="request-inspector-note">
      <span>请求快照 · 已脱敏 · {formatRequestSize(trace.stats.estimatedChars)} 字符</span>
      {trace.truncated && <span className="is-warning">快照已截断，部分内容未保存</span>}
    </div>
    <div className="request-inspector-list" key={`${tab}-${currentPage}-${query}`}>
      {tab === 'tools' ? tools.slice(start, start + PAGE_SIZE).map(tool => <RequestTool key={tool.name} tool={tool} />)
        : filtered.slice(start, start + PAGE_SIZE).map(message => <RequestTraceMessageView key={`${message.index}-${message.role}`} message={message} />)}
      {total === 0 && <p className="request-inspector-empty">{query ? '没有匹配的内容' : '此快照没有记录这类内容'}</p>}
    </div>
    <div className="request-inspector-footer">
      <span>{total ? `${start + 1}–${Math.min(start + PAGE_SIZE, total)} / ${total}` : '0 条'}{tab === 'context' && currentPage === pages - 1 ? ' · 最近上下文' : ''}</span>
      {pages > 1 && <div className="request-inspector-pages">
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(0)}>最早</button>
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <button type="button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>下一页</button>
        <button type="button" disabled={currentPage === pages - 1} onClick={() => setPage(pages - 1)}>最近</button>
      </div>}
    </div>
    <p className="request-inspector-help">助手消息为历史上下文，本次输出见后续轨迹与正文。</p>
  </div>;
}

function RequestTool({ tool }: { tool: RequestTrace['tools'][number] }) {
  const [open, setOpen] = useState(false);
  return <details className="request-tool" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span>{tool.name}</span><span>{tool.description}</span><ChevronDown /></summary>
    {open && <div className="request-tool-content"><p>{tool.description}</p>{tool.parameters !== undefined && <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>}</div>}
  </details>;
}

export function ActivityRequest({ trace, stepDisplay }: { trace: RequestTrace; stepDisplay: StepDisplay }) {
  const [open, setOpen] = useState(stepDisplay === 'detailed');
  useEffect(() => { setOpen(stepDisplay === 'detailed'); }, [stepDisplay]);
  const model = trace.model ? `${trace.model.provider}/${trace.model.modelId}` : '模型参数未记录';
  return <details className="activity-request activity-disclosure" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="activity-disclosure-summary">
      <span className="activity-request-icon activity-disclosure-icon"><Send /></span>
      <span className="activity-request-label activity-disclosure-title">模型调用</span>
      <span className="activity-request-model activity-disclosure-preview">{model}</span>
      <span className="activity-request-metrics activity-disclosure-meta">{trace.stats.messageCount} 条消息{trace.thinkingLevel ? ` · ${trace.thinkingLevel}` : ''}{trace.attempt > 1 ? ` · 重试 ${trace.attempt}` : ''}</span>
      <ChevronDown className="activity-request-chevron activity-disclosure-chevron" />
    </summary>
    {open && <div className="activity-request-body activity-disclosure-body"><RequestInspector trace={trace} /></div>}
  </details>;
}
