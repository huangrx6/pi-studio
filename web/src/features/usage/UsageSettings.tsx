import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import type { UsageAnalyticsSnapshot, UsageTotals } from '../../types/usage-types';
import { DatePicker } from '../../shared/DatePicker';
import { InfoHint } from '../../shared/InfoHint';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import {
  ALL_MODELS, dayFromToday, dayKey, heatLevel, heatmapDates, heatmapNavigation,
  modelKey, shareLabel, shareOf, tokenParts, usageModelWindow, type ModelRange,
} from './usage-presentation';
import { useUsageResource } from './use-usage-resource';
import { UsageSparkline } from './UsageSparkline';
import './usage-settings.css';

const RANGE_OPTIONS = [90, 180, 365] as const;
const DAY_LABELS = ['一', '', '三', '', '五', '', '日'];
const MODEL_RANGES: { id: ModelRange; label: string }[] = [
  { id: 'all', label: '全部时间' }, { id: 'today', label: '今天' },
  { id: '7', label: '7 天' }, { id: '30', label: '30 天' },
  { id: '90', label: '90 天' }, { id: '365', label: '1 年' }, { id: 'custom', label: '自定义' },
];
const exactNumber = (value: number) => new Intl.NumberFormat('zh-CN').format(value || 0);
function tokenNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: value >= 1_000_000 ? 2 : 1 }).format(value || 0);
}
function costNumber(value: number): string {
  if (!value) return '$0';
  if (value > 0 && value < .0001) return '<$0.0001';
  return `$${value.toFixed(value < .01 ? 4 : 2)}`;
}
function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' }).format(new Date(`${value}T00:00:00`));
}
function TokenSplit({ totals }: { totals: UsageTotals }) {
  const parts = tokenParts(totals);
  return <div className="usage-token-split" aria-label="所选日期范围的 Token 构成">
    <div className="usage-token-bar" aria-hidden="true">{parts.map(part => <i className={part.className} key={part.label} style={{ width: `${part.share * 100}%` }} />)}</div>
    <div className="usage-token-legend">{parts.map(part => <span key={part.label} title={`${part.label} ${exactNumber(part.value)} tokens`}>
      <i className={part.className} aria-hidden="true" /><span>{part.label}</span><strong>{tokenNumber(part.value)}</strong>
    </span>)}</div>
  </div>;
}
function ResourceStatus({ pending, error, hasData, onRetry, label }: {
  pending: boolean; error: string | null; hasData: boolean; onRetry: () => void; label: string;
}) {
  if (error) return <div className="usage-read-error" role="alert"><span>{label}读取失败：{error}{hasData ? '（以下显示上次读取结果）' : ''}</span><button type="button" className="settings-text-button" onClick={onRetry}>重试{label}</button></div>;
  if (pending) return <p className="usage-loading" role="status">{hasData ? `正在更新${label}，以下显示上次读取结果…` : `正在读取${label}…`}</p>;
  return null;
}

function UsageHeatmap({ snapshot, modelFilter, onModelFilterChange }: {
  snapshot: UsageAnalyticsSnapshot; modelFilter: string; onModelFilterChange: (key: string) => void;
}) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const positionedRange = useRef('');
  const selectedModel = snapshot.filterModels.find(item => modelKey(item.providerId, item.modelId) === modelFilter);
  // Removed models with history normally remain in filterModels. A vanished filter
  // must visibly fall back to "all", never keep a selected label over all-model values.
  const effectiveFilter = selectedModel ? modelFilter : ALL_MODELS;
  const filterLabel = selectedModel ? `${selectedModel.providerName} · ${selectedModel.displayName}` : '全部模型';
  const dailyByDate = useMemo(() => new Map(
    (effectiveFilter === ALL_MODELS ? snapshot.daily : snapshot.dailyModels.filter(item => modelKey(item.providerId, item.modelId) === effectiveFilter)).map(item => [item.day, item]),
  ), [snapshot, effectiveFilter]);
  const dates = useMemo(() => heatmapDates(snapshot), [snapshot]);
  const activeDates = useMemo(() => dates.filter(date => date >= snapshot.sinceDay), [dates, snapshot.sinceDay]);
  const lastDay = activeDates.at(-1) || '';
  const activeDay = selectedDay && activeDates.includes(selectedDay) ? selectedDay : lastDay;
  useLayoutEffect(() => {
    const rangeKey = `${snapshot.sinceDay}:${lastDay}:${snapshot.days}`;
    if (positionedRange.current === rangeKey) return;
    const scroller = scrollRef.current;
    const cell = gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${activeDay}"]`);
    if (!scroller || !cell) return;
    positionedRange.current = rangeKey;
    // Reveal the selected day horizontally without moving the settings page.
    // Same-range refreshes, keyboard selection and hover keep the user's position.
    const viewport = scroller.getBoundingClientRect();
    const target = cell.getBoundingClientRect();
    if (target.right > viewport.right - 3) scroller.scrollLeft += target.right - viewport.right + 3;
    else if (target.left < viewport.left + 3) scroller.scrollLeft -= viewport.left - target.left + 3;
  }, [snapshot.sinceDay, snapshot.days, lastDay, activeDay]);
  const detailDay = hoveredDay && activeDates.includes(hoveredDay) ? hoveredDay : activeDay;
  const selected = dailyByDate.get(detailDay);
  const maximum = Math.max(0, ...[...dailyByDate.values()].map(item => item.totalTokens));
  function navigate(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const next = heatmapNavigation(activeDates, date, event.key);
    if (!next) return;
    event.preventDefault();
    setSelectedDay(next);
    setHoveredDay(null);
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)?.focus();
  }
  return <>
    {snapshot.filterModels.length > 0 && <div className="usage-model-filter" role="group" aria-label="按模型筛选热力图">
      <button type="button" aria-pressed={effectiveFilter === ALL_MODELS} className={effectiveFilter === ALL_MODELS ? 'is-active' : ''} onClick={() => onModelFilterChange(ALL_MODELS)}>全部模型</button>
      {snapshot.filterModels.map(item => {
        const key = modelKey(item.providerId, item.modelId);
        return <button type="button" key={key} aria-pressed={effectiveFilter === key} className={effectiveFilter === key ? 'is-active' : ''} title={`${item.providerName} · ${item.modelId}`} onClick={() => onModelFilterChange(key)}><span>{item.displayName}</span><small>{item.providerName}{item.enabled ? '' : ' · 已停用'}</small></button>;
      })}
    </div>}
    <div className={`usage-heatmap-layout is-days-${snapshot.days}`}>
      <div ref={scrollRef} className="usage-heatmap-scroll">
        <div className="usage-heatmap-days" aria-hidden="true">{DAY_LABELS.map((label, index) => <span key={index}>{label}</span>)}</div>
        <div ref={gridRef} className="usage-heatmap-grid" role="group" aria-label={`${filterLabel}，${snapshot.days} 天 Token 使用量；上下键移动一天，左右键移动一周`} onMouseLeave={() => setHoveredDay(null)}>
          {dates.map(date => {
            const item = dailyByDate.get(date);
            const inRange = date >= snapshot.sinceDay;
            const description = `${dateLabel(date)}，${exactNumber(item?.totalTokens || 0)} tokens，${exactNumber(item?.requests || 0)} 次请求`;
            return <button type="button" key={date} data-date={date} title={description} aria-label={description} aria-pressed={activeDay === date} tabIndex={activeDay === date ? 0 : -1} disabled={!inRange}
              className={`usage-heat-cell level-${heatLevel(item?.totalTokens || 0, maximum)} ${inRange ? '' : 'is-outside'} ${activeDay === date ? 'is-selected' : ''}`}
              onFocus={() => { setSelectedDay(date); setHoveredDay(null); }} onMouseEnter={() => setHoveredDay(date)} onClick={() => setSelectedDay(date)} onKeyDown={event => navigate(event, date)} />;
          })}
        </div>
      </div>
      <div className="usage-legend"><span>每日最高 {tokenNumber(maximum)}</span><span>少</span><div aria-hidden="true">{[0, 1, 2, 3, 4].map(level => <i className={`level-${level}`} key={level} />)}</div><span>多</span></div>
    </div>
    <div className="usage-day-detail" aria-live="polite">
      {detailDay ? <><span>{dateLabel(detailDay)}</span><strong title={exactNumber(selected?.totalTokens || 0)}>{tokenNumber(selected?.totalTokens || 0)} tokens</strong><span>输入 {tokenNumber(selected?.input || 0)}</span><span>输出 {tokenNumber(selected?.output || 0)}</span><span>缓存 {tokenNumber((selected?.cacheRead || 0) + (selected?.cacheWrite || 0))}</span><span>{exactNumber(selected?.requests || 0)} 次请求</span></> : <span>暂无每日数据</span>}
    </div>
  </>;
}

export function UsageSettings({ active }: { active: boolean }) {
  const [days, setDays] = useState<number>(365);
  const [modelFilter, setModelFilter] = useState(ALL_MODELS);
  const [modelRange, setModelRange] = useState<ModelRange>('all');
  const [customFrom, setCustomFrom] = useState(() => dayFromToday(-29));
  const [customTo, setCustomTo] = useState(() => dayFromToday(0));
  const [summaryRequest, setSummaryRequest] = useState(0);
  const [mixRequest, setMixRequest] = useState(0);
  const loadSummary = useCallback(() => window.piApi.usageSummary({ days }), [days]);
  const summary = useUsageResource(active, String(days), summaryRequest, loadSummary);
  const snapshot = summary.value;
  useEffect(() => {
    if (snapshot && modelFilter !== ALL_MODELS && !snapshot.filterModels.some(item => modelKey(item.providerId, item.modelId) === modelFilter)) setModelFilter(ALL_MODELS);
  }, [snapshot, modelFilter]);
  // Recompute "today" on explicit refresh/reopening, including across midnight.
  const modelWindow = useMemo(() => usageModelWindow(modelRange, customFrom, customTo), [modelRange, customFrom, customTo, mixRequest, active]);
  const loadMix = useCallback(() => window.piApi.usageModels(modelWindow || {}), [modelWindow]);
  const mixState = useUsageResource(active && Boolean(modelWindow), JSON.stringify(modelWindow), mixRequest, loadMix);
  const mix = modelWindow ? mixState.value : null;
  const refreshing = summary.pending || (Boolean(modelWindow) && mixState.pending);
  const empty = Boolean(snapshot && snapshot.allTime.totalTokens === 0 && snapshot.allTime.requests === 0);
  function refresh() { setSummaryRequest(value => value + 1); setMixRequest(value => value + 1); }
  return <div className="settings-sections usage-settings">
    <SettingsPageHeader icon={<BarChart3 />} title="Token 使用量" meta={<span>全部工作区 · 按本地日期统计{snapshot && <span className="usage-updated-at"> · 更新于 {new Date(snapshot.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>} <InfoHint label="只读取 Studio 本地汇总。按日期、Provider 与模型统计 Token；不保存提示词、回答正文、工具参数或凭据。" /></span>}
      actions={<button type="button" className="settings-outline" disabled={refreshing} onClick={refresh}><RefreshCw className={refreshing ? 'spin' : undefined} />刷新</button>} />
    <section className="usage-summary-section" aria-label="Token 使用概览" aria-busy={summary.pending}>
      <header className="usage-section-head"><h2>近期用量</h2>{!empty && <div className="usage-range-switch" role="group" aria-label="热力图日期范围">{RANGE_OPTIONS.map(option => <button type="button" key={option} aria-pressed={days === option} className={days === option ? 'is-active' : ''} onClick={() => setDays(option)}>{option === 365 ? '1 年' : `${option} 天`}</button>)}</div>}</header>
      <ResourceStatus label="用量" pending={summary.pending} error={summary.error} hasData={Boolean(snapshot)} onRetry={() => setSummaryRequest(value => value + 1)} />
      {snapshot && (empty
        ? <div className="usage-empty-state" role="status">
            <strong>{snapshot.collection.enabled ? '还没有使用记录' : '用量采集已关闭'}</strong>
            <span>{snapshot.collection.enabled ? '开始对话后，这里会显示按本地日期汇总的 Token 和请求。' : '历史数据会保留；重新启用 Studio Metrics 后继续记录。'}</span>
          </div>
        : <>
            {!snapshot.collection.enabled && <p className="usage-collection-note">用量采集已关闭。历史数据保留；重新启用 Studio Metrics 后继续记录。</p>}
            <p className="usage-window-label">{snapshot.sinceDay} 至 {dayKey(new Date(snapshot.generatedAt))} · {snapshot.days} 天 · 全部模型</p>
            <div className="usage-hero">
              <div className="usage-hero-copy"><h3 title={`${exactNumber(snapshot.range.totalTokens)} tokens`}>{tokenNumber(snapshot.range.totalTokens)} <small>tokens</small></h3><TokenSplit totals={snapshot.range} /><UsageSparkline daily={snapshot.daily} /></div>
              <dl className="usage-stat-grid"><div className="usage-stat"><dt>请求</dt><dd>{exactNumber(snapshot.range.requests)}</dd></div><div className="usage-stat"><dt>活跃天数</dt><dd>{snapshot.range.activeDays} 天</dd></div><div className="usage-stat"><dt>估算成本 <InfoHint label="按已记录的用量成本汇总，以美元显示；未提供价格的请求可能不计入成本，这不是账单。" /></dt><dd>{costNumber(snapshot.range.cost)}</dd></div></dl>
            </div>
            <p className="usage-cumulative">累计 {tokenNumber(snapshot.allTime.totalTokens)} tokens · {exactNumber(snapshot.allTime.requests)} 次请求 · 当前连续 {snapshot.allTime.currentStreak} 天，最长 {snapshot.allTime.longestStreak} 天</p>
            <div className="usage-heatmap-card"><header className="usage-section-head"><h3>每日趋势</h3><span>模型筛选仅影响下方热力图</span></header><UsageHeatmap snapshot={snapshot} modelFilter={modelFilter} onModelFilterChange={setModelFilter} /></div>
          </>)}
    </section>
    {!empty && <section className="usage-models-card" aria-labelledby="usage-models-title" aria-busy={Boolean(modelWindow) && mixState.pending}>
      <header className="usage-section-head"><h2 id="usage-models-title">模型分布</h2><div className="usage-range-switch" role="group" aria-label="模型分布时间范围">{MODEL_RANGES.map(option => <button type="button" key={option.id} aria-pressed={modelRange === option.id} className={modelRange === option.id ? 'is-active' : ''} onClick={() => setModelRange(option.id)}>{option.label}</button>)}</div></header>
      {modelRange === 'custom' && <div className="usage-range-custom"><span>开始</span><DatePicker label="模型分布起始日期" value={customFrom} max={customTo} onChange={setCustomFrom} /><span>结束</span><DatePicker label="模型分布结束日期" value={customTo} min={customFrom} onChange={setCustomTo} /></div>}
      {!modelWindow ? <p className="usage-read-error" role="alert">请选择有效的起止日期，结束日期不能早于开始日期。</p> : <ResourceStatus label="模型分布" pending={mixState.pending} error={mixState.error} hasData={Boolean(mix)} onRetry={() => setMixRequest(value => value + 1)} />}
      {mix && <>
        <div className="usage-models-meta"><span>{mix.window.all ? '全部时间' : `${mix.window.sinceDay} 至 ${mix.window.untilDay || dayKey(new Date(mix.generatedAt))}`}</span><span>{mix.models.length} 个模型 · {tokenNumber(mix.totals.totalTokens)} tokens · {exactNumber(mix.totals.requests)} 次请求</span></div>
        {mix.models.length ? <div className="usage-model-list">{mix.models.map(model => {
          const share = shareOf(model.totalTokens, mix.totals.totalTokens);
          return <article className="usage-model-row" key={modelKey(model.providerId, model.modelId)}><div className="usage-model-main"><div className="usage-model-title"><strong>{model.displayName}</strong><span>{model.providerName} · {model.modelId}</span></div><div className="usage-model-track" aria-hidden="true"><i style={{ width: `${share * 100}%` }} /></div></div><div className="usage-model-numbers"><strong title={`${exactNumber(model.totalTokens)} tokens`}>{tokenNumber(model.totalTokens)} tokens</strong><span>{shareLabel(share)} · {exactNumber(model.requests)} 次请求</span></div></article>;
        })}</div> : <p className="usage-empty">这个时间范围内没有模型请求。</p>}
      </>}
    </section>}
  </div>;
}
