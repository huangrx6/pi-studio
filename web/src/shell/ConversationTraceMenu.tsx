import { useEffect, useRef, useState } from 'react';
import { Activity, AlertCircle, Check, ChevronDown, Circle, LoaderCircle, Send, Terminal, Wrench, X } from 'lucide-react';

export type ConversationTraceItem = {
  id: string;
  kind: 'model' | 'decision' | 'tool';
  label: string;
  preview: string;
  detail?: string;
  status: 'done' | 'running' | 'error';
  at?: number;
};

export type ConversationTraceSummary = {
  steps: number;
  requests: number;
  tools: number;
  errors: number;
  state: 'idle' | 'running' | 'done' | 'error';
  items: ConversationTraceItem[];
};

type ConversationTraceMenuProps = {
  summary: ConversationTraceSummary;
};

function stateLabel(state: ConversationTraceSummary['state']): string {
  if (state === 'running') return '执行中';
  if (state === 'error') return '有异常';
  if (state === 'done') return '已完成';
  return '暂无轨迹';
}

function ItemIcon({ kind }: { kind: ConversationTraceItem['kind'] }) {
  if (kind === 'model') return <Send aria-hidden="true" />;
  if (kind === 'decision') return <Activity aria-hidden="true" />;
  return <Terminal aria-hidden="true" />;
}

function StatusIcon({ status }: { status: ConversationTraceItem['status'] }) {
  if (status === 'running') return <LoaderCircle className="spin" aria-hidden="true" />;
  if (status === 'error') return <AlertCircle aria-hidden="true" />;
  return <Check aria-hidden="true" />;
}

export function ConversationTraceMenu({ summary }: ConversationTraceMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);

  return <div className="conversation-trace-anchor" ref={anchorRef}>
    <button
      type="button"
      className={`tab conversation-trace-tab ${open ? 'is-open' : ''}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label="打开会话轨迹"
      onClick={() => setOpen(value => !value)}
    >
      <Activity aria-hidden="true" />
      <span>轨迹</span>
      {summary.steps > 0 && <span className="tab-count">{summary.steps}</span>}
    </button>
    {open && <section className="conversation-trace-popover" role="dialog" aria-label="会话轨迹">
      <div className="conversation-trace-popover-head">
        <div>
          <strong>会话轨迹</strong>
          <span>按需查看当前会话的处理过程</span>
        </div>
        <button type="button" className="icon-button" aria-label="关闭会话轨迹" title="关闭" onClick={() => setOpen(false)}><X /></button>
      </div>
      <div className="conversation-trace-overview" aria-label="轨迹统计">
        <div><strong>{summary.steps}</strong><span>步骤</span></div>
        <div><strong>{summary.requests}</strong><span>模型请求</span></div>
        <div><strong>{summary.tools}</strong><span>工具执行</span></div>
        <div className={summary.errors > 0 ? 'has-error' : ''}><strong>{summary.errors}</strong><span>异常</span></div>
      </div>
      <div className={`conversation-trace-state is-${summary.state}`}><Circle aria-hidden="true" /><span>{stateLabel(summary.state)}</span></div>
      {summary.items.length > 0
        ? <div className="conversation-trace-list" aria-label="最近轨迹">
          {summary.items.map(item => <details className={`conversation-trace-item is-${item.status}`} key={item.id}>
            <summary>
              <span className="conversation-trace-item-icon"><ItemIcon kind={item.kind} /></span>
              <span className="conversation-trace-item-main"><strong>{item.label}</strong><span>{item.preview || '无摘要'}</span></span>
              <span className="conversation-trace-item-status" title={item.status === 'error' ? '执行失败' : item.status === 'running' ? '执行中' : '已完成'}><StatusIcon status={item.status} /></span>
              <ChevronDown className="conversation-trace-item-chevron" aria-hidden="true" />
            </summary>
            {item.detail && <pre>{item.detail}</pre>}
          </details>)}
        </div>
        : <div className="conversation-trace-empty"><Wrench aria-hidden="true" /><span>发送消息后，这里会显示模型、决策和工具步骤。</span></div>}
    </section>}
  </div>;
}
