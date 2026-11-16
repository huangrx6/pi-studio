import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy, X } from 'lucide-react';
import { LoadingState } from '../../shared/LoadingState';
import { Markdown } from '../../shared/Markdown';
import { errorText } from '../../shared/error-text';
import type { RequestTrace } from '../../types/chat-types';
import type { ConversationTraceItem } from './trace-model';
import { durationLabel, kindLabels, lane, statusLabels, timeLabel } from './trace-display';
import { RequestTraceMessageView } from './ModelRequestTrace';

type DetailTab = 'overview' | 'parameters' | 'result' | 'schema' | 'timing' | 'preview' | 'raw' | 'system' | 'context';
const isSnapshotTab = (value: DetailTab) => value === 'schema' || value === 'system' || value === 'context';

function TracePayload({ text, label }: { text: string; label: string }) {
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (feedback === 'idle') return;
    const timer = window.setTimeout(() => setFeedback('idle'), 2400);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback('copied');
    } catch {
      setFeedback('failed');
    }
  }
  return <section className="trace-payload">
    <header><h4>{label}</h4>{text && <button type="button" aria-label={`复制${label}`} onClick={() => void copy()}>
      {feedback === 'copied' ? <Check /> : <Copy />}<span role="status">{feedback === 'copied' ? '已复制' : feedback === 'failed' ? '复制失败' : '复制'}</span>
    </button>}</header>
    <pre>{text}</pre>
  </section>;
}

export function TraceDetail({ item, index, count, initialFocus, onMove, onClose }: {
  item: ConversationTraceItem;
  index: number;
  count: number;
  initialFocus: -1 | 0 | 1;
  onMove: (direction: -1 | 1) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const [requested, setRequested] = useState(false);
  const [saved, setSaved] = useState<RequestTrace>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const close = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const { conversationId, requestId, snapshot: mode } = item.request ?? {};
  const previous = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const requested = initialFocus > 0 ? next.current : previous.current;
    const other = initialFocus > 0 ? previous.current : next.current;
    const target = initialFocus === 0 ? close.current : requested?.disabled ? other : requested;
    (target ?? close.current)?.focus({ preventScroll: true });
  }, [initialFocus]);
  useEffect(() => {
    if (!requested || mode !== 'deferred' || !conversationId || !requestId) return;
    let current = true;
    window.piApi.conversationRequestTrace(conversationId, requestId).then(value => {
      if (!current) return;
      if (!value) throw new Error('请求快照暂不可用');
      setSaved(value);
    }).catch(cause => { if (current) setError(errorText(cause)); });
    return () => { current = false; };
  }, [requested, mode, conversationId, requestId, retry]);
  const snapshot = mode === 'deferred' ? saved : item.request;
  const tabs: Array<[DetailTab, string]> = item.kind === 'tool'
    ? [['overview', '概述'], ['parameters', '参数'], ['result', '结果'], ['schema', '工具定义'], ['timing', '计时']]
    : item.kind === 'model'
      ? [['overview', '概述'], ['system', '系统提示词'], ['context', '上下文'], ['schema', '工具定义']]
      : [['overview', '概述'], ['preview', '预览'], ['raw', '原始内容']];
  function activate(value: DetailTab) {
    setTab(value);
    if (isSnapshotTab(value)) setRequested(true);
  }
  const schema = item.kind === 'tool'
    ? snapshot?.tools?.filter(tool => tool.name === item.label || tool.name === item.label.split('/').at(-1))
    : snapshot?.tools;
  const messages = snapshot?.messages?.filter(message => tab === 'system' ? message.role === 'system' : message.role !== 'system');
  const timing = <dl className="trace-detail-facts"><dt>记录时间</dt><dd>{timeLabel(item.at)}</dd><dt>结束时间</dt><dd>{timeLabel(item.endedAt)}</dd><dt>耗时</dt><dd>{durationLabel(item.durationMs)}</dd></dl>;
  const result = item.result || (item.status === 'running' ? '工具正在执行，等待返回结果。' : '这次调用没有保存结果。');
  const snapshotTab = isSnapshotTab(tab);
  function excerpt(label: string, value: string, destination: DetailTab) {
    return <section><h4>{label}</h4><pre>{value.length > 320 ? `${value.slice(0, 320)}…` : value}</pre>
      {value.length > 320 && <button className="text-button" type="button" onClick={() => activate(destination)}>查看完整{label}</button>}</section>;
  }
  return <aside className="conversation-trace-detail" aria-label="轨迹详情" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
  }}>
    <header className="conversation-trace-detail-head">
      <span className={`trace-kind lane-${lane(item)}`}>{kindLabels[item.kind]}</span>
      <div><strong>{item.label}</strong><small>第 {item.round ?? 1} 轮 · 第 {item.step ?? 1} 步</small></div>
      <button ref={close} className="icon-button" type="button" aria-label="关闭轨迹详情" title="关闭详情（Esc）" onClick={onClose}><X /></button>
    </header>
    <div className="trace-detail-tabs" role="tablist" aria-label="轨迹详情内容">{tabs.map(([value, label], index) => <button
      key={value} id={`${panelId}-${value}`} type="button" role="tab" aria-controls={panelId} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
      onClick={() => activate(value)} onKeyDown={event => {
        const target = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        activate(tabs[target][0]);
        event.currentTarget.parentElement?.querySelectorAll('button')[target]?.focus();
      }}>{label}</button>)}</div>
    <div key={tab} id={panelId} className="trace-detail-content" role="tabpanel" aria-labelledby={`${panelId}-${tab}`} tabIndex={0}>
      {tab === 'overview' && <>
        <dl className="trace-detail-facts"><dt>状态</dt><dd className={`is-${item.status}`}>{item.kind === 'model' && item.status === 'done' ? '请求已记录' : statusLabels[item.status]}</dd>
          {item.request && <><dt>模型</dt><dd>{item.request.model ? `${item.request.model.provider}/${item.request.model.modelId}` : '未记录'}</dd><dt>请求 ID</dt><dd>{requestId}</dd></>}
          {item.kind === 'model' && item.request && <><dt>输入规模</dt><dd>{item.request.stats.messageCount} 条消息 · {item.request.stats.estimatedChars.toLocaleString()} 字符</dd>
            <dt>可用工具</dt><dd>{item.request.stats.toolDefinitionCount} 个</dd></>}
          <dt>记录时间</dt><dd>{timeLabel(item.at)}</dd>
          {item.durationMs !== undefined && <><dt>耗时</dt><dd>{durationLabel(item.durationMs)}</dd></>}
        </dl>
        {item.kind === 'tool' ? <>{excerpt('参数', item.detail ?? '未记录参数', 'parameters')}{excerpt('结果', result, 'result')}</>
          : item.kind !== 'model' && excerpt(item.status === 'error' ? '错误信息' : '内容', item.detail || '暂无内容', 'preview')}
      </>}
      {tab === 'parameters' && (item.detail ? <TracePayload text={item.detail} label="参数" /> : <p>未记录参数</p>)}
      {tab === 'result' && (item.result ? <TracePayload text={item.result} label="结果" /> : <p>{result}</p>)}
      {tab === 'timing' && timing}
      {tab === 'preview' && <Markdown>{item.detail || '暂无内容'}</Markdown>}
      {tab === 'raw' && (item.detail ? <TracePayload text={item.detail} label="原始内容" /> : <p>暂无内容</p>)}
      {snapshotTab && (error ? <div role="alert"><p>{error}</p><button className="text-button" type="button" onClick={() => { setError(''); setRetry(value => value + 1); }}>重新读取快照</button></div>
        : mode === 'deferred' && !saved ? <LoadingState>正在读取请求快照…</LoadingState>
        : tab === 'schema' ? (schema?.length ? schema.map(tool => <section key={tool.name}><h4>{tool.name}</h4><p>{tool.description}</p>
          {tool.parameters !== undefined && <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>}</section>) : <p>这条记录没有保存对应的工具定义。</p>)
        : messages?.length ? messages.map(message => <RequestTraceMessageView key={message.index} message={message} defaultOpen={messages.length === 1} />)
        : <p>{tab === 'system' ? '这次请求没有保存系统提示词。' : '这次请求没有保存上下文消息。'}</p>)}
      {snapshotTab && snapshot?.truncated && <p className="trace-detail-note">快照已截断，以上为已保存的内容。</p>}
    </div>
    {count > 1 && <nav className="trace-record-navigation" aria-label="浏览筛选后的轨迹">
      <button ref={previous} type="button" disabled={index === 0} onClick={() => onMove(-1)}><ChevronLeft />上一条</button>
      <span>{index + 1} / {count}</span>
      <button ref={next} type="button" disabled={index + 1 === count} onClick={() => onMove(1)}>下一条<ChevronRight /></button>
    </nav>}
  </aside>;
}
