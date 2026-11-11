import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Activity, AlertCircle, Check, Clock3, Layers, ListTree, LoaderCircle, Search, Sparkles, SquareMinus, User, Wrench, X } from 'lucide-react';
import { Markdown } from '../shared/Markdown';
import type { RequestTrace } from '../types/chat-types';
import type { ConversationTraceItem, ConversationTraceSummary } from '../features/conversation/trace-model';
export type { ConversationTraceItem, ConversationTraceSummary } from '../features/conversation/trace-model';

type ConversationTraceProps = { summary: ConversationTraceSummary };
const kindLabels = { input: '用户', model: '模型', decision: '思考', assistant: '助手', tool: '工具' };
const statusLabels = { done: '已完成', running: '执行中', error: '异常', unknown: '结果未记录' };
const lane = (item: ConversationTraceItem) => item.kind === 'input' ? 'input' : item.kind === 'tool' ? 'tool' : 'model';
function timeLabel(at?: number) {
  return at === undefined ? '未记录' : new Date(at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
}
function durationLabel(ms?: number) {
  if (ms === undefined) return '未记录';
  return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(2)} 秒`;
}
function ItemIcon({ kind }: { kind: ConversationTraceItem['kind'] }) {
  if (kind === 'input') return <User />;
  if (kind === 'tool') return <Wrench />;
  if (kind === 'model') return <Activity />;
  return <Sparkles />;
}
function StatusIcon({ status }: { status: ConversationTraceItem['status'] }) {
  if (status === 'running') return <LoaderCircle className="spin" />;
  if (status === 'error' || status === 'unknown') return <AlertCircle />;
  return <Check />;
}

function TraceActivityMap({ items, selectedId, onSelect }: {
  items: ConversationTraceItem[];
  selectedId: string | null;
  onSelect: (item: ConversationTraceItem) => void;
}) {
  const [hover, setHover] = useState<{ item: ConversationTraceItem; x: number; y: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
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
          aria-pressed={selectedId === item.id}
          onMouseEnter={event => showHover(item, event.currentTarget)} onMouseLeave={() => setHover(null)}
          onFocus={event => showHover(item, event.currentTarget)} onBlur={() => setHover(null)}
          onClick={() => { setHover(null); onSelect(item); }}
        />)}
      </div>
    </div>
    {hover && createPortal(<div className="trace-activity-tooltip" role="tooltip" style={{ left: hover.x, top: hover.y }}>
      <strong>{kindLabels[hover.item.kind]} · {hover.item.label}</strong>
      <span>{timeLabel(hover.item.at)}{hover.item.endedAt !== undefined ? ` → ${timeLabel(hover.item.endedAt)}` : ''}</span>
      <span>{statusLabels[hover.item.status]} · 耗时 {durationLabel(hover.item.durationMs)}</span>
      <p>{hover.item.preview}</p>
    </div>, document.body)}
  </div>;
}

type DetailTab = 'overview' | 'parameters' | 'result' | 'schema' | 'timing' | 'preview' | 'raw' | 'system' | 'context';
function TraceDetail({ item, onClose }: { item: ConversationTraceItem; onClose: () => void }) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const [snapshot, setSnapshot] = useState<RequestTrace | undefined>(item.request);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setSnapshot(item.request);
    setError('');
    if (!item.request || item.request.snapshot !== 'deferred') return;
    setLoading(true);
    window.piApi.conversationRequestTrace(item.request.conversationId, item.request.requestId).then(value => {
      if (!current) return;
      if (!value) throw new Error('这条请求快照暂不可用');
      setSnapshot(value);
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : '读取请求快照失败'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [item.request, retry]);
  const tabs: Array<[DetailTab, string]> = item.kind === 'tool'
    ? [['overview', '概述'], ['parameters', '参数'], ['result', '结果'], ['schema', 'Schema'], ['timing', '计时']]
    : item.kind === 'model'
      ? [['overview', '概述'], ['system', '系统提示词'], ['context', '上下文'], ['schema', '工具']]
      : [['overview', '概述'], ['preview', '预览'], ['raw', '原始内容']];
  const schema = item.kind === 'tool' ? snapshot?.tools?.filter(tool => tool.name === item.label || tool.name === item.label.split('/').at(-1)) : snapshot?.tools;
  const timing = <dl className="trace-detail-facts"><dt>记录时间</dt><dd>{timeLabel(item.at)}</dd><dt>结束时间</dt><dd>{timeLabel(item.endedAt)}</dd><dt>耗时</dt><dd>{durationLabel(item.durationMs)}</dd></dl>;
  const content = <Markdown>{item.detail || '暂无内容'}</Markdown>;
  return <aside className="conversation-trace-detail" aria-label="轨迹详情" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <header className="conversation-trace-detail-head">
      <span className={`trace-kind lane-${lane(item)}`}>{kindLabels[item.kind]}</span><span>第 {item.round ?? 1} 轮 · 第 {item.step ?? 1} 步</span>
      <button className="icon-button" type="button" aria-label="关闭轨迹详情" onClick={onClose}><X /></button>
    </header>
    <div className="trace-detail-tabs" role="tablist" aria-label="轨迹详情内容">{tabs.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}</div>
    <div className="trace-detail-content" role="tabpanel" aria-label={tabs.find(([value]) => value === tab)?.[1]}>
      {tab === 'overview' && <>
        <dl className="trace-detail-facts"><dt>名称</dt><dd>{item.label}</dd><dt>状态</dt><dd className={`is-${item.status}`}>{statusLabels[item.status]}</dd>
          {item.request && <><dt>来源</dt><dd>{item.request.model?.modelId || '模型请求'}</dd><dt>请求</dt><dd>{item.request.requestId}</dd></>}
          {item.kind === 'model' && <><dt>输入消息</dt><dd>{item.request?.stats.messageCount}</dd><dt>字符</dt><dd>{item.request?.stats.estimatedChars}</dd></>}
        </dl>
        {item.kind === 'tool' ? <><section><h4>参数</h4><pre>{item.detail}</pre></section><section><h4>结果</h4><pre>{item.result || '尚无工具结果'}</pre></section></>
          : <section><h4>预览</h4>{content}</section>}
        <section><h4>计时</h4>{timing}</section>
      </>}
      {tab === 'parameters' && <pre>{item.detail || '暂无参数'}</pre>}
      {tab === 'result' && <pre>{item.result || '尚无工具结果'}</pre>}
      {tab === 'timing' && timing}
      {tab === 'preview' && content}
      {tab === 'raw' && <pre>{item.detail || '暂无内容'}</pre>}
      {(tab === 'system' || tab === 'context') && snapshot?.messages?.filter(message => tab === 'system' ? message.role === 'system' : message.role !== 'system').map(message => <section key={message.index}><h4>{message.role}</h4><pre>{message.content.map(block => block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : JSON.stringify(block, null, 2)).join('\n')}</pre></section>)}
      {tab === 'schema' && (schema?.length ? schema.map(tool => <section key={tool.name}><h4>{tool.name}</h4><p>{tool.description}</p><pre>{JSON.stringify(tool.parameters, null, 2)}</pre></section>) : <p>该记录未保存工具定义。</p>)}
      {loading && <p role="status">正在读取请求快照…</p>}
      {error && <div role="alert"><p>{error}</p><button className="text-button" type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
      {snapshot?.truncated && <p className="trace-detail-note">原始快照已截断，当前展示已保存内容。</p>}
    </div>
  </aside>;
}

export function ConversationTraceTab({ active, onOpen }: ConversationTraceProps & { active: boolean; onOpen: () => void }) {
  return <button type="button" role="tab" aria-selected={active} className={`tab conversation-trace-tab ${active ? 'is-active' : ''}`} aria-label="打开会话轨迹页面" onClick={onOpen}><Activity aria-hidden="true" /><span>轨迹</span></button>;
}

const TRACE_PAGE = 120;

export function ConversationTracePage({ summary }: ConversationTraceProps) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [durations, setDurations] = useState(false);
  const [rounds, setRounds] = useState(true);
  const [calls, setCalls] = useState(true);
  const [subcalls, setSubcalls] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // 一次只挂载视口附近的记录：上千条轨迹全部挂载会让整页渲染变重。
  const [visibleCount, setVisibleCount] = useState(TRACE_PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  const selected = summary.items.find(item => item.id === selectedId);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return summary.items.filter(item => (calls || item.kind !== 'model') && (subcalls || item.kind !== 'tool') && (!needle || `${item.label} ${item.preview} ${item.detail || ''} ${item.result || ''}`.toLocaleLowerCase().includes(needle)));
  }, [summary.items, query, calls, subcalls]);
  const [jumpId, setJumpId] = useState<string | null>(null);
  useEffect(() => { setVisibleCount(TRACE_PAGE); }, [query, calls, subcalls]);
  // 搜索命中或地图跳转可能落在已挂载范围之外，先把它所在的一段补齐。
  useEffect(() => {
    if (!jumpId) return;
    const index = filtered.findIndex((item) => item.id === jumpId);
    if (index >= visibleCount) setVisibleCount(Math.min(filtered.length, index + 60));
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
      setVisibleCount((current) => Math.min(filtered.length, current + TRACE_PAGE));
    }, { root, rootMargin: '600px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visibleCount, filtered.length]);
  const selectFromMap = (item: ConversationTraceItem) => {
    setQuery(''); setCalls(true); setSubcalls(true); setSelectedId(item.id); setJumpId(item.id);
  };
  const closeDetail = () => { setSelectedId(null); rowRefs.current.get(selectedId || '')?.focus({ preventScroll: true }); };
  return <div className="conversation-trace-page" role="tabpanel" aria-label="会话轨迹">
    <div className="conversation-trace-page-inner">
      <div className="conversation-trace-toolbar">
        <div className="trace-display-options" role="group" aria-label="轨迹显示选项">
          <button type="button" aria-pressed={durations} onClick={() => setDurations(value => !value)} title="显示每条记录的时间与已记录耗时"><Clock3 />时长</button>
          <button type="button" aria-pressed={rounds} onClick={() => setRounds(value => !value)} title="显示对话轮次分隔"><Layers />轮次</button>
          <button type="button" aria-pressed={calls} onClick={() => setCalls(value => !value)} title="显示模型调用记录"><SquareMinus />调用</button>
          <button type="button" aria-pressed={subcalls} onClick={() => setSubcalls(value => !value)} title="显示模型发起的工具子调用"><ListTree />子调用</button>
        </div>
        <label className="conversation-trace-search"><Search /><input aria-label="搜索轨迹" placeholder="搜索" value={query} onChange={event => setQuery(event.target.value)} /></label>
      </div>
      <TraceActivityMap items={summary.items} selectedId={selectedId} onSelect={selectFromMap} />
      <div className={`conversation-trace-workspace ${selected ? 'has-detail' : ''}`}>
        <div className="conversation-trace-list" ref={list} aria-label="轨迹记录">
          {filtered.slice(0, visibleCount).map((item, index) => <Fragment key={item.id}>
            {rounds && item.round !== filtered[index - 1]?.round && <div className="trace-round-marker">第 {item.round ?? 1} 轮</div>}
            <button ref={node => { if (node) rowRefs.current.set(item.id, node); else rowRefs.current.delete(item.id); }} type="button" className={`conversation-trace-item lane-${lane(item)} is-${item.status} ${selectedId === item.id ? 'is-selected' : ''}`} aria-pressed={selectedId === item.id} onClick={() => setSelectedId(item.id)}>
              <span className="conversation-trace-item-icon"><ItemIcon kind={item.kind} /></span>
              {(item.kind === 'tool' || item.kind === 'model' || item.kind === 'input') && <span className="conversation-trace-item-title">{item.kind === 'model' ? '模型' : item.label}</span>}
              <span className="conversation-trace-item-preview">{item.preview || '暂无内容'}{item.result && <span className="trace-result-preview"> → {item.result.replace(/\s+/g, ' ')}</span>}</span>
              {durations && <time className="conversation-trace-item-time" title={timeLabel(item.at)}>{item.durationMs !== undefined ? durationLabel(item.durationMs) : timeLabel(item.at)}</time>}
              {item.status !== 'done' && <span className="conversation-trace-item-status" title={statusLabels[item.status]}><StatusIcon status={item.status} /></span>}
            </button>
          </Fragment>)}
          {visibleCount < filtered.length && <div ref={sentinel} className="conversation-trace-sentinel" aria-hidden="true" />}
          {!filtered.length && <div className="conversation-trace-empty">{summary.items.length ? '没有匹配的轨迹' : '发送消息后显示执行轨迹'}</div>}
        </div>
        {selected && <TraceDetail key={selected.id} item={selected} onClose={closeDetail} />}
      </div>
    </div>
  </div>;
}
