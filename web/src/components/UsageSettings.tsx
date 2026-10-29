import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  CalendarDays,
  Clock3,
  Cpu,
  Database,
  Flame,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type { UsageAnalyticsSnapshot, UsageDay } from '../types/usage-types';
import { SettingsPageHeader } from './SettingsPageHeader';

const RANGE_OPTIONS = [90, 180, 365] as const;
const DAY_LABELS = ['一', '', '三', '', '五', '', '日'];
const ALL_MODELS = '__all__';

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`;
}

function tokenNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1_000_000 ? 2 : 1,
  }).format(value || 0);
}

function costNumber(value: number): string {
  if (!value) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(`${value}T00:00:00`));
}

function parseDay(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function dayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function heatmapDates(snapshot: UsageAnalyticsSnapshot): string[] {
  const start = parseDay(snapshot.sinceDay);
  const end = parseDay(dayKey(new Date(snapshot.generatedAt)));
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);
  const dates: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function heatLevel(value: number, maximum: number): number {
  if (!value) return 0;
  if (maximum <= 0) return 1;
  const ratio = value / maximum;
  if (ratio <= 0.18) return 1;
  if (ratio <= 0.42) return 2;
  if (ratio <= 0.72) return 3;
  return 4;
}

function StatCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
}) {
  return <article className="usage-stat">
    <span className="usage-stat-icon">{icon}</span>
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  </article>;
}

function TokenSplit({ snapshot }: { snapshot: UsageAnalyticsSnapshot }) {
  const total = Math.max(1, snapshot.range.totalTokens);
  const parts = [
    { label: '输入', value: snapshot.range.input, className: 'is-input' },
    { label: '输出', value: snapshot.range.output, className: 'is-output' },
    {
      label: '缓存',
      value: snapshot.range.cacheRead + snapshot.range.cacheWrite,
      className: 'is-cache',
    },
  ];
  return <div className="usage-token-split" aria-label="Token 构成">
    <div className="usage-token-bar">
      {parts.map((part) => <i
        className={part.className}
        key={part.label}
        style={{ width: `${Math.max(part.value > 0 ? 1.2 : 0, part.value / total * 100)}%` }}
      />)}
    </div>
    <div className="usage-token-legend">
      {parts.map((part) => <span key={part.label}>
        <i className={part.className} />
        <span>{part.label}</span>
        <strong>{tokenNumber(part.value)}</strong>
      </span>)}
    </div>
  </div>;
}

export function UsageSettings({ active }: { active: boolean }) {
  const [days, setDays] = useState<number>(365);
  const [snapshot, setSnapshot] = useState<UsageAnalyticsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState<string>(ALL_MODELS);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setLoading(true);
    setError(null);
    void window.piApi.usageSummary({ days })
      .then((next) => {
        if (disposed) return;
        setSnapshot(next);
        setSelectedDay((current) => (
          current && next.daily.some((item) => item.day === current)
            ? current
            : next.daily.at(-1)?.day || null
        ));
      })
      .catch((cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => { disposed = true; };
  }, [active, days, request]);

  const allDailyByDate = useMemo(
    () => new Map((snapshot?.daily || []).map((item) => [item.day, item])),
    [snapshot],
  );
  const modelDailyByDate = useMemo(
    () => new Map((snapshot?.dailyModels || []).map((item) => [
      `${modelKey(item.providerId, item.modelId)}\0${item.day}`,
      item,
    ])),
    [snapshot],
  );
  const selectedModel = useMemo(
    () => snapshot?.filterModels.find(
      (item) => modelKey(item.providerId, item.modelId) === modelFilter,
    ),
    [modelFilter, snapshot],
  );
  const dailyByDate = useMemo(() => {
    if (!snapshot || modelFilter === ALL_MODELS || !selectedModel) return allDailyByDate;
    const prefix = `${modelFilter}\0`;
    return new Map(
      [...modelDailyByDate.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, item]) => [key.slice(prefix.length), item]),
    );
  }, [allDailyByDate, modelDailyByDate, modelFilter, selectedModel, snapshot]);
  const dates = useMemo(() => snapshot ? heatmapDates(snapshot) : [], [snapshot]);
  const maximum = useMemo(
    () => Math.max(0, ...[...dailyByDate.values()].map((item) => item.totalTokens)),
    [dailyByDate],
  );
  const selected = selectedDay ? dailyByDate.get(selectedDay) : undefined;
  const modelMaximum = Math.max(1, ...(snapshot?.models || []).map((item) => item.totalTokens));
  const filterLabel = selectedModel
    ? `${selectedModel.providerName} · ${selectedModel.displayName}`
    : '全部模型';

  useEffect(() => {
    if (!snapshot || modelFilter === ALL_MODELS) return;
    if (snapshot.filterModels.some((item) => modelKey(item.providerId, item.modelId) === modelFilter)) return;
    setModelFilter(ALL_MODELS);
  }, [modelFilter, snapshot]);

  return <div className="settings-sections usage-settings">
    <SettingsPageHeader
      icon={<BarChart3 />}
      title="Token 使用量"
      description="按本地日期、Provider 与模型聚合模型请求。热力图可查看全部、当前启用或曾使用但已停用的模型，长期只保存紧凑的每日汇总。"
      meta={<span className="count-badge">本地 SQLite</span>}
      actions={<button
        type="button"
        className="settings-outline"
        disabled={loading}
        onClick={() => setRequest((value) => value + 1)}
      >
        <RefreshCw className={loading ? 'spin' : undefined} />
        刷新
      </button>}
    />

    {error && <div className="settings-error" role="alert">
      <strong>暂时无法读取用量</strong>
      <span>{error}</span>
    </div>}

    {!snapshot && loading && <div className="usage-loading" role="status">
      <span /><span /><span />
      <strong>正在汇总本地用量</strong>
    </div>}

    {snapshot && <>
      {!snapshot.collection.enabled && <div className="usage-collection-note">
        <ShieldCheck />
        <div>
          <strong>用量采集已关闭</strong>
          <span>历史数据仍会显示；重新启用内置“Studio Metrics”扩展后，从下一次请求开始继续记录。</span>
        </div>
      </div>}

      <section className="usage-hero" aria-label="Token 使用概览">
        <div className="usage-hero-copy">
          <span className="usage-eyebrow"><Activity />LLM ACTIVITY</span>
          <h2>{tokenNumber(snapshot.allTime.totalTokens)}<small> tokens</small></h2>
          <p>从第一笔本地记录累计至今。近期输入、输出与缓存构成会实时来自 Studio SQLite。</p>
          <TokenSplit snapshot={snapshot} />
        </div>
        <div className="usage-stat-grid">
          <StatCard
            icon={<Flame />}
            label="当前连续"
            value={`${snapshot.allTime.currentStreak} 天`}
            detail={`最长 ${snapshot.allTime.longestStreak} 天`}
          />
          <StatCard
            icon={<BarChart3 />}
            label="近段请求"
            value={snapshot.range.requests}
            detail={`${snapshot.allTime.requests} 次累计`}
          />
          <StatCard
            icon={<ArrowUpFromLine />}
            label="输出 Token"
            value={tokenNumber(snapshot.range.output)}
            detail={`${tokenNumber(snapshot.range.cacheRead + snapshot.range.cacheWrite)} 缓存`}
          />
          <StatCard
            icon={<Database />}
            label="估算成本"
            value={costNumber(snapshot.range.cost)}
            detail="由模型请求回传"
          />
        </div>
      </section>

      <section className="usage-heatmap-card" aria-labelledby="usage-heatmap-title">
        <header className="usage-section-head">
          <div>
            <span className="usage-eyebrow"><CalendarDays />DAILY TOKENS</span>
            <h2 id="usage-heatmap-title">每日使用热力图</h2>
          </div>
          <div className="usage-range-switch" aria-label="热力图日期范围">
            {RANGE_OPTIONS.map((option) => <button
              type="button"
              className={days === option ? 'is-active' : ''}
              aria-pressed={days === option}
              key={option}
              onClick={() => setDays(option)}
            >{option === 365 ? '1 年' : `${option} 天`}</button>)}
          </div>
        </header>

        {snapshot.filterModels.length > 0 && <div className="usage-model-filter" role="group" aria-label="按模型筛选热力图">
          <button
            type="button"
            className={modelFilter === ALL_MODELS ? 'is-active' : ''}
            aria-pressed={modelFilter === ALL_MODELS}
            onClick={() => setModelFilter(ALL_MODELS)}
          >全部模型</button>
          {snapshot.filterModels.map((item) => {
            const key = modelKey(item.providerId, item.modelId);
            return <button
              type="button"
              className={modelFilter === key ? 'is-active' : ''}
              aria-pressed={modelFilter === key}
              key={key}
              title={`${item.providerName} · ${item.modelId}`}
              onClick={() => setModelFilter(key)}
            >
              <span>{item.displayName}</span>
              <small>{item.providerName}{item.enabled ? '' : ' · 已停用'}</small>
            </button>;
          })}
        </div>}

        <div className={`usage-heatmap-layout is-days-${days} ${loading ? 'is-loading' : ''}`}>
          <div className="usage-heatmap-scroll">
            <div className="usage-heatmap-days" aria-hidden="true">
              {DAY_LABELS.map((label, index) => <span key={index}>{label}</span>)}
            </div>
            <div className="usage-heatmap-grid" role="grid" aria-label={`${filterLabel}，${days} 天 Token 使用量`}>
              {dates.map((date) => {
                const item = dailyByDate.get(date);
                const inRange = date >= snapshot.sinceDay;
                return <button
                  type="button"
                  role="gridcell"
                  aria-label={`${dateLabel(date)}，${item ? `${tokenNumber(item.totalTokens)} tokens，${item.requests} 次请求` : '无使用'}`}
                  aria-selected={selectedDay === date}
                  className={`usage-heat-cell level-${heatLevel(item?.totalTokens || 0, maximum)} ${inRange ? '' : 'is-outside'} ${selectedDay === date ? 'is-selected' : ''}`}
                  disabled={!inRange}
                  key={date}
                  onFocus={() => inRange && setSelectedDay(date)}
                  onMouseEnter={() => inRange && setSelectedDay(date)}
                  onClick={() => inRange && setSelectedDay(date)}
                />;
              })}
            </div>
          </div>
          <div className="usage-legend">
            <span>{tokenNumber(maximum)} 最高</span>
            <div aria-hidden="true">{[0, 1, 2, 3, 4].map((level) => <i className={`level-${level}`} key={level} />)}</div>
            <span>少</span><span>多</span>
          </div>
        </div>

        <div className="usage-day-detail" aria-live="polite">
          {selectedDay
            ? <>
              <span><CalendarDays />{dateLabel(selectedDay)}</span>
              <strong>{tokenNumber(selected?.totalTokens || 0)} <small>tokens</small></strong>
              <span><ArrowDownToLine />输入 {tokenNumber(selected?.input || 0)}</span>
              <span><ArrowUpFromLine />输出 {tokenNumber(selected?.output || 0)}</span>
              <span><Cpu />{selected?.requests || 0} 次请求</span>
            </>
            : <span><Clock3 />选择任意日期查看当天明细</span>}
        </div>
      </section>

      <section className="usage-models-card" aria-labelledby="usage-models-title">
        <header className="usage-section-head">
          <div>
            <span className="usage-eyebrow"><Cpu />MODEL MIX</span>
            <h2 id="usage-models-title">模型分布</h2>
          </div>
          <span className="usage-models-total">{snapshot.models.length} 个模型</span>
        </header>
        {snapshot.models.length > 0
          ? <div className="usage-model-list">
            {snapshot.models.map((model, index) => {
              const rangeTotal = Math.max(0, Number(snapshot.range.totalTokens) || 0);
              const modelTotal = Math.max(0, Number(model.totalTokens) || 0);
              const share = rangeTotal > 0 ? modelTotal / rangeTotal : 0;
              return <article className="usage-model-row" key={`${model.providerId}/${model.modelId}`}>
                <span className="usage-model-rank">{String(index + 1).padStart(2, '0')}</span>
                <div className="usage-model-main">
                  <div className="usage-model-title">
                    <strong>{model.displayName}</strong>
                    <span>{model.providerName} · {model.modelId}</span>
                  </div>
                  <div className="usage-model-track" aria-hidden="true">
                    <i style={{ width: `${Math.max(1, share * 100)}%` }} />
                  </div>
                </div>
                <div className="usage-model-numbers">
                  <strong>{tokenNumber(modelTotal)}</strong>
                  <span>{Math.round(share * 1000) / 10}% · {model.requests} 次</span>
                </div>
              </article>;
            })}
          </div>
          : <div className="usage-empty">
            <BarChart3 />
            <strong>还没有可统计的模型请求</strong>
            <span>完成一次正常问答后，这里会按 Provider 和模型分开汇总。</span>
          </div>}
      </section>

      <footer className="usage-footnote">
        <span><ShieldCheck />长期只保存每天、Provider 与模型的 Token 汇总</span>
        <span>请求 ID 仅用于短期去重；不保存提示词、回答正文、工具参数或凭据</span>
      </footer>
    </>}
  </div>;
}
