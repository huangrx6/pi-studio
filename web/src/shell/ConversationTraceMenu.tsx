import { useMemo, useState } from 'react';
import { Activity, AlertCircle, Check, ChevronRight, Circle, Clock3, LoaderCircle, Search, Send, Terminal, Wrench, X } from 'lucide-react';
import { DetailDialog } from '../shared/DetailDialog';

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

function kindLabel(kind: ConversationTraceItem['kind']): string {
  if (kind === 'model') return '模型请求';
  if (kind === 'decision') return '决策';
  return '工具执行';
}

function timeLabel(at?: number): string {
  return at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--';
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
  const [filter, setFilter] = useState<'all' | ConversationTraceItem['kind']>('all');
  const [query, setQuery] = useState('');
  const [selectedItem, setSelectedItem] = useState<ConversationTraceItem | null>(null);
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return summary.items.filter((item) => {
      if (filter !== 'all' && item.kind !== filter) return false;
      if (!needle) return true;
      return `${item.label} ${item.preview} ${item.detail || ''}`.toLocaleLowerCase().includes(needle);
    });
  }, [filter, query, summary.items]);
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
      <div className="conversation-trace-toolbar">
        <div className="conversation-trace-filters" role="group" aria-label="轨迹筛选">
          {([['all', '全部'], ['model', '模型'], ['decision', '决策'], ['tool', '工具']] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <label className="conversation-trace-search">
          <Search aria-hidden="true" />
          <input aria-label="搜索轨迹" placeholder="搜索轨迹" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      <div className="conversation-trace-overview" aria-label="轨迹统计">
        <div><strong>{summary.steps}</strong><span>步骤</span></div>
        <div><strong>{summary.requests}</strong><span>模型请求</span></div>
        <div><strong>{summary.tools}</strong><span>工具执行</span></div>
        <div className={summary.errors > 0 ? 'has-error' : ''}><strong>{summary.errors}</strong><span>异常</span></div>
      </div>
      {filteredItems.length > 0
        ? <div className="conversation-trace-list" aria-label="最近轨迹">
          {filteredItems.map((item, index) => <button className={`conversation-trace-item is-${item.status}`} key={item.id} type="button" onClick={() => setSelectedItem(item)}>
            <span className="conversation-trace-item-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="conversation-trace-item-icon"><ItemIcon kind={item.kind} /></span>
            <span className="conversation-trace-item-main">
              <span className="conversation-trace-item-meta"><strong>{kindLabel(item.kind)}</strong><time><Clock3 aria-hidden="true" />{timeLabel(item.at)}</time></span>
              <span className="conversation-trace-item-title">{item.label}</span>
              <span className="conversation-trace-item-preview">{item.preview || '暂无摘要，打开详情查看完整内容'}</span>
            </span>
            <span className="conversation-trace-item-status" title={item.status === 'error' ? '执行失败' : item.status === 'running' ? '执行中' : '已完成'}><StatusIcon status={item.status} /></span>
            <ChevronRight className="conversation-trace-item-chevron" aria-hidden="true" />
          </button>)}
        </div>
        : <div className="conversation-trace-empty"><Wrench aria-hidden="true" /><span>{summary.items.length > 0 ? '没有匹配的轨迹。' : '发送消息后，这里会显示模型、决策和工具步骤。'}</span></div>}
    </div>
    {selectedItem && <DetailDialog onClose={() => setSelectedItem(null)} className="trace-detail-dialog">
      <header className="trace-detail-header">
        <div className="trace-detail-heading">
          <span className={`trace-detail-icon is-${selectedItem.kind}`}><ItemIcon kind={selectedItem.kind} /></span>
          <div><span className="trace-detail-kicker">{kindLabel(selectedItem.kind)}</span><h2>{selectedItem.label}</h2></div>
        </div>
        <button type="button" className="icon-button" aria-label="关闭详情" onClick={() => setSelectedItem(null)}><X aria-hidden="true" /></button>
      </header>
      <div className="trace-detail-statusbar"><span className={`trace-detail-status is-${selectedItem.status}`}><StatusIcon status={selectedItem.status} />{selectedItem.status === 'error' ? '执行失败' : selectedItem.status === 'running' ? '执行中' : '已完成'}</span><span><Clock3 aria-hidden="true" />{timeLabel(selectedItem.at)}</span><span>ID {selectedItem.id}</span></div>
      <div className="trace-detail-body">
        <section><h3>摘要</h3><p>{selectedItem.preview || '暂无摘要'}</p></section>
        <section><h3>执行内容</h3>{selectedItem.detail ? <pre>{selectedItem.detail}</pre> : <p className="trace-detail-muted">该步骤没有可展开的原始内容。</p>}</section>
      </div>
    </DetailDialog>}
  </div>;
}
