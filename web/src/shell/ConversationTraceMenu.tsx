import { Activity, AlertCircle, Check, ChevronDown, Circle, LoaderCircle, Send, Terminal, Wrench } from 'lucide-react';

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

type ConversationTraceProps = {
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

export function ConversationTraceTab({ summary, active, onOpen }: ConversationTraceProps & { active: boolean; onOpen: () => void }) {
  return <button
    type="button"
    role="tab"
    aria-selected={active}
    className={`tab conversation-trace-tab ${active ? 'is-active' : ''}`}
    aria-label="打开会话轨迹页面"
    onClick={onOpen}
  >
    <Activity aria-hidden="true" />
    <span>轨迹</span>
    {summary.steps > 0 && <span className="tab-count">{summary.steps}</span>}
  </button>;
}

export function ConversationTracePage({ summary }: ConversationTraceProps) {
  return <div className="conversation-trace-page" role="tabpanel" aria-label="会话轨迹">
    <div className="conversation-trace-page-inner">
      <header className="conversation-trace-page-head">
        <div>
          <div className="conversation-trace-page-kicker"><Activity aria-hidden="true" /><span>当前会话</span></div>
          <h2>会话轨迹</h2>
          <p>按时间查看模型请求、决策和工具执行状态。</p>
        </div>
        <div className={`conversation-trace-state is-${summary.state}`}><Circle aria-hidden="true" /><span>{stateLabel(summary.state)}</span></div>
      </header>
      <div className="conversation-trace-overview" aria-label="轨迹统计">
        <div><strong>{summary.steps}</strong><span>步骤</span></div>
        <div><strong>{summary.requests}</strong><span>模型请求</span></div>
        <div><strong>{summary.tools}</strong><span>工具执行</span></div>
        <div className={summary.errors > 0 ? 'has-error' : ''}><strong>{summary.errors}</strong><span>异常</span></div>
      </div>
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
    </div>
  </div>;
}
