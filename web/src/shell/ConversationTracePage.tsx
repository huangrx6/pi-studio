import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useSurfaceActive } from '../shared/surface-visibility';
import { Activity, AlertCircle, Check, Clock3, Layers, ListTree, Search, Sparkles, SquareMinus, User, Wrench, X } from 'lucide-react';
import { LoadingIndicator } from '../shared/LoadingState';
import { SessionViewHeader } from './SessionViewHeader';
import { TraceDetail } from '../features/conversation/TraceDetail';
import { durationLabel, kindLabels, lane, statusLabels, timeLabel } from '../features/conversation/trace-display';
import type { ConversationTraceItem, ConversationTraceSummary } from '../features/conversation/trace-model';

type ConversationTracePageProps = { summary: ConversationTraceSummary };
function ItemIcon({ kind }: { kind: ConversationTraceItem['kind'] }) {
  if (kind === 'input') return <User />;
  if (kind === 'tool') return <Wrench />;
  if (kind === 'model') return <Activity />;
  return <Sparkles />;
}
function StatusIcon({ status }: { status: ConversationTraceItem['status'] }) {
  if (status === 'running') return <LoadingIndicator />;
  if (status === 'error' || status === 'unknown') return <AlertCircle />;
  return <Check />;
}

function TraceActivityMap({ items, selectedId, onSelect }: {
  items: ConversationTraceItem[];
  selectedId: string | null;
  onSelect: (item: ConversationTraceItem) => void;
}) {
  const [hover, setHover] = useState<{ item: ConversationTraceItem; x: number; y: number } | null>(null);
  const active = useSurfaceActive();
  useEffect(() => { if (!active) setHover(null); }, [active]);
  const root = useRef<HTMLDivElement>(null);
  const [focusId, setFocusId] = useState<string>();
  const tabStop = items.some(item => item.id === focusId) ? focusId : selectedId ?? items[0]?.id;
  useEffect(() => {
    const selected = root.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (selected) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId]);
  const showHover = (item: ConversationTraceItem, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setHover({ item, x: Math.min(Math.max(rect.left, 8), window.innerWidth - 292), y: Math.min(rect.bottom + 8, window.innerHeight - 180) });
  };
  return <div className="conversation-trace-activity" aria-label="轨迹活动概览">
    <div className="conversation-trace-activity-labels"><span>输入</span><span>模型</span><span>工具</span></div>
    <div className="conversation-trace-activity-scroll" ref={root} onScroll={() => setHover(null)}>
      <div className="conversation-trace-activity-grid" style={{ '--activity-count': Math.max(1, items.length) } as CSSProperties}>
        {items.map((item, index) => <button
          key={item.id} type="button" className={`trace-activity-cell lane-${lane(item)} is-${item.status}`}
          style={{ gridColumn: index + 1, gridRow: lane(item) === 'input' ? 1 : lane(item) === 'model' ? 2 : 3 }}
          aria-label={`${kindLabels[item.kind]} · 第 ${item.round ?? 1} 轮 · ${item.label}`}
          aria-pressed={selectedId === item.id} tabIndex={tabStop === item.id ? 0 : -1}
          onKeyDown={event => {
            const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: items.length - 1 }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            root.current?.querySelectorAll<HTMLButtonElement>('button')[Math.min(items.length - 1, Math.max(0, next))]?.focus();
          }}
          onMouseEnter={event => showHover(item, event.currentTarget)} onMouseLeave={() => setHover(null)}
          onFocus={event => { setFocusId(item.id); showHover(item, event.currentTarget); }} onBlur={() => setHover(null)}
          onClick={() => { setHover(null); onSelect(item); }}
        />)}
      </div>
    </div>
    {active && hover && createPortal(<div className="trace-activity-tooltip" role="tooltip" style={{ left: hover.x, top: hover.y }}>
      <strong>{kindLabels[hover.item.kind]} · {hover.item.label}</strong>
      <span>{timeLabel(hover.item.at)}{hover.item.endedAt !== undefined ? ` → ${timeLabel(hover.item.endedAt)}` : ''}</span>
      <span>{statusLabels[hover.item.status]} · 耗时 {durationLabel(hover.item.durationMs)}</span>
      <p>{hover.item.preview}</p>
    </div>, document.body)}
  </div>;
}

// 首批与每次追加都按视口行数算：标准窗口约 50 条，矮屏自动降到 24 条，
// 再大的窗口也封顶 60，避免一次挂出远超一屏的内容。
const TRACE_ROW_HEIGHT = 32;
const TRACE_PAGE_MIN = 24;
const TRACE_PAGE_MAX = 60;

function tracePageSize(viewportHeight: number): number {
  const rows = Math.ceil(Math.max(0, viewportHeight) / TRACE_ROW_HEIGHT);
  return Math.min(TRACE_PAGE_MAX, Math.max(TRACE_PAGE_MIN, rows * 2 + 8));
}

export function ConversationTracePage({ summary }: ConversationTracePageProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'error' | 'running' | 'unknown'>('all');
  const search = useRef<HTMLInputElement>(null);
  const stats = useMemo(() => {
    const counts = { all: summary.items.length, error: 0, running: 0, unknown: 0, rounds: 0 };
    for (const item of summary.items) {
      if (item.status !== 'done') counts[item.status]++;
      counts.rounds = Math.max(counts.rounds, item.round ?? 1);
    }
    return counts;
  }, [summary.items]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [durations, setDurations] = useState(false);
  const [rounds, setRounds] = useState(true);
  const [calls, setCalls] = useState(true);
  const [subcalls, setSubcalls] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // 一次只挂载视口附近的记录：上千条轨迹全部挂载会让整页渲染变重。
  const [visibleCount, setVisibleCount] = useState(TRACE_PAGE_MIN);
  const sentinel = useRef<HTMLDivElement>(null);
  const detailFocus = useRef<-1 | 0 | 1>(0);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return summary.items.filter(item => (status === 'all' || item.status === status) && (calls || item.kind !== 'model') && (subcalls || item.kind !== 'tool') && (!needle || `${kindLabels[item.kind]} ${item.label} ${item.request?.requestId ?? ''} ${item.preview} ${item.detail || ''} ${item.result || ''}`.toLocaleLowerCase().includes(needle)));
  }, [summary.items, query, status, calls, subcalls]);
  const [jumpId, setJumpId] = useState<string | null>(null);
  // 列表尺寸变化（窗口缩放、面板收放）时按新的视口重新算首批条数。
  useEffect(() => {
    const root = list.current;
    if (!root) return undefined;
    const fit = () => setVisibleCount((current) => (
      Math.min(filtered.length, Math.max(current, tracePageSize(root.clientHeight)))
    ));
    fit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    return () => observer.disconnect();
  }, [filtered.length]);
  useEffect(() => {
    setVisibleCount(tracePageSize(list.current?.clientHeight ?? 0));
    if (list.current) list.current.scrollTop = 0;
  }, [query, status, calls, subcalls]);
  // 搜索命中或地图跳转可能落在已挂载范围之外，先把它所在的一段补齐。
  useEffect(() => {
    if (!jumpId) return;
    const index = filtered.findIndex((item) => item.id === jumpId);
    if (index >= visibleCount) { setVisibleCount(index + 1); return; }
    rowRefs.current.get(jumpId)?.scrollIntoView({ block: 'center', inline: 'nearest' });
    setJumpId(null);
  }, [jumpId, filtered, visibleCount]);
  // 滚到底部再挂载下一段。
  useEffect(() => {
    const node = sentinel.current;
    const root = list.current;
    if (!node || !root || visibleCount >= filtered.length) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      // 首次布局完成前哨兵会短暂落在视口里，这里再用滚动位置确认一次，
      // 否则一进页面就会把条数翻倍。
      if (root.scrollTop + root.clientHeight < node.offsetTop - 600) return;
      setVisibleCount((current) => Math.min(filtered.length, current + tracePageSize(root.clientHeight)));
    }, { root, rootMargin: '600px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visibleCount, filtered.length]);
  const selectFromMap = (item: ConversationTraceItem) => {
    if (!filtered.some(row => row.id === item.id)) {
      if (status !== 'all' && status !== item.status) setStatus('all');
      if (item.kind === 'model') setCalls(true);
      if (item.kind === 'tool') setSubcalls(true);
      setQuery('');
    }
    detailFocus.current = 0;
    setSelectedId(item.id);
    setJumpId(item.id);
  };
  const clearFilters = () => { setStatus('all'); setQuery(''); setCalls(true); setSubcalls(true); };
  const closeDetail = () => {
    setSelectedId(null);
    requestAnimationFrame(() => (rowRefs.current.get(selectedId || '') ?? search.current)?.focus({ preventScroll: true }));
  };
  // Keep the inspector paired with a visible record as the user narrows the list.
  const activeIndex = selectedId ? filtered.findIndex(item => item.id === selectedId) : -1;
  const activeItem = filtered[activeIndex];
  const moveDetail = (direction: -1 | 1) => {
    const next = filtered[activeIndex + direction];
    if (!next) return;
    detailFocus.current = direction;
    setSelectedId(next.id);
    setJumpId(next.id);
  };
  useEffect(() => { if (selectedId && !activeItem) setSelectedId(null); }, [selectedId, activeItem]);
  return <section className="conversation-trace-page" aria-label="会话轨迹">
    <SessionViewHeader title="会话轨迹"
      summary={stats.all ? `${stats.rounds} 轮对话 · ${summary.requests} 次模型请求 · ${summary.tools} 次工具调用` : undefined} />
    <div className="conversation-trace-page-inner">
      {stats.all > 0 && <>
      <div className="conversation-trace-toolbar">
        <div className="trace-status-filters" role="group" aria-label="筛选轨迹状态">
          {([['all', '全部'], ['error', '异常'], ['running', '执行中'], ['unknown', '结果未记录']] as const)
            .filter(([value]) => value === 'all' || value === 'error' || stats[value] || status === value)
            .map(([value, label]) => <button key={value} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}>{label}<span>{stats[value]}</span></button>)}
        </div>
        <label className="conversation-trace-search"><Search /><input ref={search} aria-label="搜索轨迹" placeholder="搜索工具、请求或内容" value={query} onChange={event => setQuery(event.target.value)} />
          {query && <button type="button" aria-label="清空轨迹搜索" onClick={() => { setQuery(''); search.current?.focus(); }}><X /></button>}</label>
      </div>
      <TraceActivityMap items={summary.items} selectedId={activeItem?.id ?? null} onSelect={selectFromMap} />
      <div className="trace-list-toolbar"><strong>执行记录 <span>{filtered.length}</span></strong>
        <div className="trace-display-options" role="group" aria-label="轨迹显示选项">
          <button type="button" aria-pressed={durations} onClick={() => setDurations(value => !value)} title="显示每条记录的时间与已记录耗时"><Clock3 />时长</button>
          <button type="button" aria-pressed={rounds} onClick={() => setRounds(value => !value)} title="显示对话轮次分隔"><Layers />轮次</button>
          <button type="button" aria-pressed={calls} onClick={() => setCalls(value => !value)} title="显示模型调用记录"><SquareMinus />模型请求</button>
          <button type="button" aria-pressed={subcalls} onClick={() => setSubcalls(value => !value)} title="显示模型发起的工具子调用"><ListTree />工具调用</button>
        </div>
      </div></>}
      <div className={`conversation-trace-workspace ${activeItem ? 'has-detail' : ''}`}>
        <div className="conversation-trace-list" ref={list} aria-label="轨迹记录">
          {filtered.slice(0, visibleCount).map((item, index) => <Fragment key={item.id}>
            {rounds && item.round !== filtered[index - 1]?.round && <div className="trace-round-marker">第 {item.round ?? 1} 轮</div>}
            <button ref={node => { if (node) rowRefs.current.set(item.id, node); else rowRefs.current.delete(item.id); }} type="button" className={`conversation-trace-item lane-${lane(item)} is-${item.status} ${selectedId === item.id ? 'is-selected' : ''}`} aria-pressed={selectedId === item.id} onClick={() => { detailFocus.current = 0; setSelectedId(item.id); }}>
              <span className="conversation-trace-item-icon"><ItemIcon kind={item.kind} /></span>
              <span className="conversation-trace-item-title">{item.label}</span>
              <span className="conversation-trace-item-preview">{item.preview || '暂无内容'}{item.result && <span className="trace-result-preview"> → {item.result.slice(0, 220).replace(/\s+/g, ' ')}</span>}</span>
              {durations && <time className="conversation-trace-item-time" title={timeLabel(item.at)}>{item.durationMs !== undefined ? durationLabel(item.durationMs) : timeLabel(item.at)}</time>}
              {item.status !== 'done' && <span className="conversation-trace-item-status" title={statusLabels[item.status]}><StatusIcon status={item.status} />{statusLabels[item.status]}</span>}
            </button>
          </Fragment>)}
          {visibleCount < filtered.length && <div ref={sentinel} className="conversation-trace-sentinel" aria-hidden="true" />}
          {!filtered.length && <div className="conversation-trace-empty"><Activity aria-hidden="true" />
            <strong>{stats.all ? '没有匹配的轨迹' : '还没有执行记录'}</strong>
            {stats.all ? <button type="button" className="text-button" onClick={clearFilters}>清除筛选</button>
              : <p>在对话中发送消息后，可以在这里查看模型请求、工具调用和执行结果。</p>}
          </div>}
        </div>
        {activeItem && <TraceDetail key={`${activeItem.id}/${activeItem.request?.id ?? ''}`} item={activeItem} onClose={closeDetail}
          index={activeIndex} count={filtered.length} onMove={moveDetail} initialFocus={detailFocus.current} />}

      </div>
    </div>
  </section>;
}
