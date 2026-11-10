import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, Check, ChevronRight, Circle, Clock3, LoaderCircle, Search, Send, Terminal, Wrench } from 'lucide-react';

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

function TraceActivityMap({ items }: { items: ConversationTraceItem[] }) {
  const rows: Array<{ key: ConversationTraceItem['kind']; label: string }> = [
    { key: 'model', label: '模型' },
    { key: 'decision', label: '决策' },
    { key: 'tool', label: '工具' },
  ];
  return <div className="conversation-trace-activity" aria-label="轨迹活动概览">
    <div className="conversation-trace-activity-labels"><span>模型</span><span>决策</span><span>工具</span></div>
    <div className="conversation-trace-activity-grid">
      {rows.map(row => <div className="conversation-trace-activity-row" key={row.key}>
        <span className="conversation-trace-activity-row-label">{row.label}</span>
        <div className="conversation-trace-activity-cells">{items.slice(0, 96).map((item, index) => <i key={`${row.key}-${item.id}-${index}`} className={item.kind === row.key ? `is-${item.status}` : 'is-empty'} aria-hidden="true" />)}</div>
      </div>)}
    </div>
  </div>;
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
  const [timeRange, setTimeRange] = useState<'all' | 'hour' | 'day' | 'week'>('all');
  const [query, setQuery] = useState('');
  const [selectedItem, setSelectedItem] = useState<ConversationTraceItem | null>(summary.items[0] ?? null);
  useEffect(() => {
    setSelectedItem(current => current && summary.items.some(item => item.id === current.id) ? current : summary.items[0] ?? null);
  }, [summary.items]);
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const now = Date.now();
    const rangeStart = timeRange === 'hour' ? now - 60 * 60 * 1000
      : timeRange === 'day' ? now - 24 * 60 * 60 * 1000
        : timeRange === 'week' ? now - 7 * 24 * 60 * 60 * 1000 : 0;
    return summary.items.filter((item) => {
      if (filter !== 'all' && item.kind !== filter) return false;
      if (rangeStart > 0 && (!item.at || item.at < rangeStart)) return false;
      if (!needle) return true;
      return `${item.label} ${item.preview} ${item.detail || ''}`.toLocaleLowerCase().includes(needle);
    });
  }, [filter, query, summary.items, timeRange]);
  useEffect(() => {
    setSelectedItem(current => current && filteredItems.some(item => item.id === current.id) ? current : filteredItems[0] ?? null);
  }, [filteredItems]);
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
        <div className="conversation-trace-toolbar-groups">
        <div className="conversation-trace-filters" role="group" aria-label="时间范围">
          {([['all', '全部时间'], ['hour', '近 1 小时'], ['day', '今天'], ['week', '近 7 天']] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={timeRange === value} onClick={() => setTimeRange(value)}>{label}</button>
          ))}
        </div>
        <div className="conversation-trace-filters" role="group" aria-label="轨迹类型">
          {([['all', '全部'], ['model', '模型'], ['decision', '决策'], ['tool', '工具']] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        </div>
        <label className="conversation-trace-search">
          <Search aria-hidden="true" />
          <input aria-label="搜索轨迹" placeholder="搜索轨迹" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      <TraceActivityMap items={summary.items} />
      <div className="conversation-trace-overview" aria-label="轨迹统计">
        <div><strong>{summary.steps}</strong><span>步骤</span></div>
        <div><strong>{summary.requests}</strong><span>模型请求</span></div>
        <div><strong>{summary.tools}</strong><span>工具执行</span></div>
        <div className={summary.errors > 0 ? 'has-error' : ''}><strong>{summary.errors}</strong><span>异常</span></div>
      </div>
      {filteredItems.length > 0
        ? <div className="conversation-trace-workspace">
          <div className="conversation-trace-list" aria-label="最近轨迹">
          {filteredItems.map((item, index) => <button className={`conversation-trace-item is-${item.status} ${selectedItem?.id === item.id ? 'is-selected' : ''}`} key={item.id} type="button" onClick={() => setSelectedItem(item)}>
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
          {selectedItem && <aside className="conversation-trace-detail" aria-label="轨迹详情">
            <div className="conversation-trace-detail-head"><div><span className="conversation-trace-detail-kicker">{kindLabel(selectedItem.kind)}</span><h3>{selectedItem.label}</h3></div><span className={`conversation-trace-detail-status is-${selectedItem.status}`}><StatusIcon status={selectedItem.status} /></span></div>
            <div className="conversation-trace-detail-meta"><span><Clock3 aria-hidden="true" />{timeLabel(selectedItem.at)}</span><span>步骤 {Math.max(1, filteredItems.findIndex(item => item.id === selectedItem.id) + 1)}</span><span>ID {selectedItem.id}</span></div>
            <section><h4>摘要</h4><p>{selectedItem.preview || '暂无摘要'}</p></section>
            <section><h4>执行内容</h4>{selectedItem.detail ? <pre>{selectedItem.detail}</pre> : <p className="conversation-trace-detail-muted">该步骤没有额外内容。</p>}</section>
          </aside>}
        </div>
        : <div className="conversation-trace-empty"><Wrench aria-hidden="true" /><span>{summary.items.length > 0 ? '没有匹配的轨迹。' : '发送消息后，这里会显示模型、决策和工具步骤。'}</span></div>}
    </div>
  </div>;
}
