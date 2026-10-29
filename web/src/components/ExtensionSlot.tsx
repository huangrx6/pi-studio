import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleEllipsis,
  Clock3,
  Info,
  LoaderCircle,
  Minus,
  Plug,
  TrendingDown,
  TrendingUp,
  X,
  XCircle,
} from 'lucide-react';
import type {
  ExtensionCommandResult,
  ExtensionContent,
  ExtensionDataViewSnapshot,
  ExtensionMetric,
  ExtensionSettingsPage,
  ExtensionStatus,
  ExtensionTone,
  ExtensionUiAction,
  ExtensionUiItem,
  ExtensionUiSlot,
  ExtensionUiSnapshot,
} from '../types/extension-types';
import { useExtensionUiSnapshot } from '../lib/use-extension-ui';

export type ExtensionNotice = { message: string; tone?: ExtensionTone };

type ExtensionSlotProps = {
  slot: ExtensionUiSlot;
  /** Exactly one always-mounted slot owns command-menu and global panel dialogs. */
  hostGlobalPanels?: boolean;
  cwd?: string;
  sessionId?: string;
  modelRef?: string;
  onOpenSettings?: (page?: ExtensionSettingsPage) => void;
  onSendPrompt?: (text: string, submit: boolean) => void;
  onNotify?: (notice: ExtensionNotice) => void;
  /** Lets a parent coordinate tabs and content with one extension snapshot. */
  snapshot?: ExtensionUiSnapshot;
  selectedItemId?: string;
  presentation?: 'cards' | 'page' | 'inline' | 'compact';
};

type ContentProps = {
  blocks: ExtensionContent[];
  busyButton: string | null;
  onAction: (action: ExtensionUiAction) => void;
  depth?: number;
  cwd?: string;
  sessionId?: string;
  modelRef?: string;
  compact?: boolean;
};

const MAX_RENDER_DEPTH = 8;
const MAX_ACTION_CHAIN = 4;

function toneIcon(tone: ExtensionTone) {
  if (tone === 'success') return <CheckCircle2 />;
  if (tone === 'warning') return <AlertTriangle />;
  if (tone === 'error') return <XCircle />;
  if (tone === 'info') return <Info />;
  return <Circle />;
}

function statusIcon(status: ExtensionStatus) {
  if (status === 'success') return <CheckCircle2 />;
  if (status === 'error') return <XCircle />;
  if (status === 'warning') return <AlertTriangle />;
  if (status === 'active') return <Activity />;
  if (status === 'pending') return <Clock3 />;
  return <Circle />;
}

function MetricCard({ metric }: { metric: ExtensionMetric }) {
  const trend = metric.trend;
  return <article className={`extension-metric is-${metric.tone || 'neutral'}`}>
    <span className="extension-metric-label">{metric.label}</span>
    <strong className="extension-metric-value" title={`${metric.value}${metric.unit ? ` ${metric.unit}` : ''}`}>
      <span className="extension-metric-number">{metric.value}</span>
      {metric.unit && <small>{metric.unit}</small>}
    </strong>
    <span className="extension-metric-meta">
      {trend && <span className={`extension-metric-trend is-${trend.tone || 'neutral'}`}>
        {trend.direction === 'up' ? <TrendingUp /> : trend.direction === 'down' ? <TrendingDown /> : <Minus />}
        {trend.label}
      </span>}
      {metric.detail && <span>{metric.detail}</span>}
    </span>
  </article>;
}

function Sparkline({ label, values, unit, tone = 'accent' }: {
  label: string;
  values: number[];
  unit?: string;
  tone?: 'accent' | 'info' | 'success' | 'warning' | 'error';
}) {
  const finite = values.filter(Number.isFinite);
  const min = finite.length ? Math.min(...finite) : 0;
  const max = finite.length ? Math.max(...finite) : 1;
  const span = max - min || 1;
  const points = finite.map((value, index) => {
    const x = finite.length === 1 ? 0 : (index / (finite.length - 1)) * 100;
    const y = 30 - ((value - min) / span) * 26;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const latest = finite.at(-1);
  return <div className={`extension-sparkline is-${tone}`}>
    <div className="extension-sparkline-head"><span>{label}</span><strong>{latest ?? '—'}{latest !== undefined && unit ? <small>{unit}</small> : null}</strong></div>
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label={`${label}趋势`}>
      <path d="M0 31H100" className="extension-chart-axis" />
      {points && <polyline points={points} className="extension-chart-line" />}
    </svg>
  </div>;
}

function Chart({ title, description, labels, series, unit }: {
  title: string;
  description?: string;
  labels?: string[];
  series: Array<{ id: string; label: string; values: number[]; tone?: string }>;
  unit?: string;
}) {
  const allValues = series.flatMap((item) => item.values).filter(Number.isFinite);
  const min = allValues.length ? Math.min(...allValues) : 0;
  const max = allValues.length ? Math.max(...allValues) : 1;
  const span = max - min || 1;
  const maxPoints = Math.max(1, ...series.map((item) => item.values.length));
  return <figure className="extension-chart">
    <figcaption>
      <span><strong>{title}</strong>{description && <small>{description}</small>}</span>
      {unit && <span className="extension-chart-unit">{unit}</span>}
    </figcaption>
    <svg viewBox="0 0 100 42" preserveAspectRatio="none" role="img" aria-label={title}>
      <path d="M0 41H100" className="extension-chart-axis" />
      {series.map((item) => {
        const values = item.values.filter(Number.isFinite);
        const points = values.map((value, index) => {
          const x = values.length === 1 ? 0 : (index / Math.max(maxPoints - 1, 1)) * 100;
          const y = 38 - ((value - min) / span) * 34;
          return `${x.toFixed(2)},${y.toFixed(2)}`;
        }).join(' ');
        return points ? <polyline key={item.id} points={points} className={`extension-chart-line is-${item.tone || 'accent'}`} /> : null;
      })}
    </svg>
    <div className="extension-chart-legend">
      {series.map((item) => <span className={`is-${item.tone || 'accent'}`} key={item.id}><i />{item.label}</span>)}
      {labels?.at(-1) && <span className="extension-chart-label">{labels.at(-1)}</span>}
    </div>
  </figure>;
}

function LiveDataView({
  block,
  busyButton,
  onAction,
  depth,
  cwd,
  sessionId,
  modelRef,
  compact = false,
}: Omit<ContentProps, 'blocks'> & {
  block: Extract<ExtensionContent, { kind: 'dataView' }>;
  depth: number;
}) {
  const [snapshot, setSnapshot] = useState<ExtensionDataViewSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let subscriptionId = '';
    setSnapshot(null);
    setLoading(true);
    setError('');
    const accept = (next: ExtensionDataViewSnapshot) => {
      if (next.sourceId !== block.sourceId) return;
      setSnapshot((current) => current && current.revision > next.revision ? current : next);
      setError(next.error || '');
      setLoading(false);
    };
    const off = window.piApi.onExtensionDataView((event) => {
      if (!subscriptionId || event.subscriptionId !== subscriptionId) return;
      accept(event.snapshot);
    });
    void window.piApi.openExtensionDataView({
      sourceId: block.sourceId,
      cwd,
      sessionId,
      modelRef,
    }).then((opened) => {
      subscriptionId = opened.subscriptionId;
      if (disposed) {
        void window.piApi.closeExtensionDataView(subscriptionId);
        return;
      }
      accept(opened.snapshot);
    }).catch((reason) => {
      if (disposed) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
    return () => {
      disposed = true;
      off();
      if (subscriptionId) void window.piApi.closeExtensionDataView(subscriptionId);
    };
  }, [block.sourceId, cwd, modelRef, sessionId]);

  if (error) {
    return <div className="extension-notice is-error" role="status">
      <XCircle />
      <span><strong>实时数据不可用</strong>{error}</span>
    </div>;
  }
  if (loading) {
    if (block.fallback?.length) {
      return <div className="extension-data-view is-loading">
        <ContentBlocks
          blocks={block.fallback}
          busyButton={busyButton}
          onAction={onAction}
          depth={depth + 1}
          cwd={cwd}
          sessionId={sessionId}
          modelRef={modelRef}
          compact={compact}
        />
      </div>;
    }
    return <div className="extension-empty is-compact" role="status">
      <span><LoaderCircle className="spin" /></span>
      <strong>正在连接实时数据</strong>
    </div>;
  }
  if (!snapshot?.content.length) {
    return <div className="extension-empty is-compact">
      <span><BarChart3 /></span>
      <strong>{block.emptyText || '暂无实时数据'}</strong>
    </div>;
  }
  return <div className="extension-data-view">
    <ContentBlocks
      blocks={snapshot.content}
      busyButton={busyButton}
      onAction={onAction}
      depth={depth + 1}
      cwd={cwd}
      sessionId={sessionId}
      modelRef={modelRef}
      compact={compact}
    />
  </div>;
}

function CompactContentBlocks({
  blocks,
  busyButton,
  onAction,
  depth = 0,
  cwd,
  sessionId,
  modelRef,
}: ContentProps) {
  return <div className="extension-compact-content">
    {blocks.map((block, index) => {
      if (block.kind === 'text') return <span key={index}>{block.text}</span>;
      if (block.kind === 'badge') {
        return <span className={`extension-badge is-${block.tone || 'neutral'}`} key={index}>{block.label}</span>;
      }
      if (block.kind === 'keyValue') {
        return <span className="extension-compact-kv" key={index}>
          {block.items.map((item, itemIndex) => <span key={itemIndex}>
            <small>{item.label}</small>
            <strong>{item.value}</strong>
          </span>)}
        </span>;
      }
      if (block.kind === 'notice') {
        return <span className={`extension-compact-notice is-${block.tone}`} key={index}>{block.text}</span>;
      }
      if (block.kind === 'dataView') {
        return <LiveDataView
          key={index}
          block={block}
          busyButton={busyButton}
          onAction={onAction}
          depth={depth + 1}
          cwd={cwd}
          sessionId={sessionId}
          modelRef={modelRef}
          compact
        />;
      }
      return null;
    })}
  </div>;
}

function ContentBlocks({
  blocks,
  busyButton,
  onAction,
  depth = 0,
  cwd,
  sessionId,
  modelRef,
  compact = false,
}: ContentProps) {
  if (depth > MAX_RENDER_DEPTH) {
    return <div className="extension-notice is-error"><strong>内容层级过深</strong><span>扩展没有通过 Studio 的安全渲染限制。</span></div>;
  }
  if (compact) {
    return <CompactContentBlocks
      blocks={blocks}
      busyButton={busyButton}
      onAction={onAction}
      depth={depth}
      cwd={cwd}
      sessionId={sessionId}
      modelRef={modelRef}
      compact
    />;
  }
  return <div className="extension-content">
    {blocks.map((block, index) => {
      if (block.kind === 'heading') {
        const Heading = block.level === 2 ? 'h2' : 'h3';
        return <Heading key={index}>{block.text}</Heading>;
      }
      if (block.kind === 'text') return <p key={index}>{block.text}</p>;
      if (block.kind === 'divider') return <hr key={index} />;
      if (block.kind === 'list') return <ul key={index}>{block.items.map((item, itemIndex) => (
        <li key={itemIndex}><span>{item.title && <strong>{item.title}</strong>}{item.text}</span></li>
      ))}</ul>;
      if (block.kind === 'keyValue') return <dl key={index}>{block.items.map((item, itemIndex) => (
        <div key={itemIndex}><dt>{item.label}</dt><dd>{item.value}</dd></div>
      ))}</dl>;
      if (block.kind === 'notice') return <div className={`extension-notice is-${block.tone}`} key={index}>
        {toneIcon(block.tone)}
        <span>{block.title && <strong>{block.title}</strong>}{block.text}</span>
      </div>;
      if (block.kind === 'badge') return <span className={`extension-badge is-${block.tone || 'neutral'}`} key={index}>{block.label}</span>;
      if (block.kind === 'section') return <section className={`extension-section is-${block.tone || 'neutral'} is-${block.density || 'comfortable'}`} key={index}>
        {(block.title || block.description) && <header>
          <span>{block.title && <strong>{block.title}</strong>}{block.description && <small>{block.description}</small>}</span>
        </header>}
        <ContentBlocks blocks={block.content} busyButton={busyButton} onAction={onAction} depth={depth + 1} cwd={cwd} sessionId={sessionId} modelRef={modelRef} />
      </section>;
      if (block.kind === 'stack') return <div className={`extension-stack is-${block.gap || 'comfortable'}`} key={index}>
        <ContentBlocks blocks={block.content} busyButton={busyButton} onAction={onAction} depth={depth + 1} cwd={cwd} sessionId={sessionId} modelRef={modelRef} />
      </div>;
      if (block.kind === 'grid') return <div className={`extension-grid is-cols-${block.columns || 2} is-${block.density || 'comfortable'}`} key={index}>
        <ContentBlocks blocks={block.content} busyButton={busyButton} onAction={onAction} depth={depth + 1} cwd={cwd} sessionId={sessionId} modelRef={modelRef} />
      </div>;
      if (block.kind === 'tabs') return <ExtensionTabs
        key={index}
        block={block}
        busyButton={busyButton}
        onAction={onAction}
        depth={depth + 1}
        cwd={cwd}
        sessionId={sessionId}
        modelRef={modelRef}
      />;
      if (block.kind === 'disclosure') return <details className="extension-disclosure" key={index} open={block.open}>
        <summary>
          <span><strong>{block.title}</strong>{block.description && <small>{block.description}</small>}</span>
          <ChevronDown />
        </summary>
        <ContentBlocks blocks={block.content} busyButton={busyButton} onAction={onAction} depth={depth + 1} cwd={cwd} sessionId={sessionId} modelRef={modelRef} />
      </details>;
      if (block.kind === 'metricGrid') return <div className={`extension-metric-grid is-cols-${block.columns || 2}`} key={index}>
        {block.metrics.map((metric) => <MetricCard metric={metric} key={metric.id} />)}
      </div>;
      if (block.kind === 'metric') {
        const { kind: _kind, ...metric } = block;
        return <MetricCard metric={metric} key={index} />;
      }
      if (block.kind === 'sparkline') return <Sparkline key={index} label={block.label} values={block.values} unit={block.unit} tone={block.tone} />;
      if (block.kind === 'chart') return <Chart key={index} title={block.title} description={block.description} labels={block.labels} series={block.series} unit={block.unit} />;
      if (block.kind === 'timeline') return <section className="extension-timeline" key={index}>
        {block.title && <h3>{block.title}</h3>}
        <ol>{block.items.map((item) => <li className={`is-${item.status || 'neutral'}`} key={item.id}>
          <span className="extension-status-icon">{statusIcon(item.status || 'neutral')}</span>
          <span><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span>
          {item.time && <time>{item.time}</time>}
        </li>)}</ol>
      </section>;
      if (block.kind === 'statusList') return <section className="extension-status-list" key={index}>
        {block.title && <h3>{block.title}</h3>}
        <div>{block.items.map((item) => <article className={`is-${item.status || 'neutral'}`} key={item.id}>
          <span className="extension-status-icon">{statusIcon(item.status || 'neutral')}</span>
          <span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>
        </article>)}</div>
      </section>;
      if (block.kind === 'table') return <section className="extension-table-wrap" key={index}>
        {block.title && <h3>{block.title}</h3>}
        <div className="extension-table-scroll">
          <table className="extension-table">
            <thead><tr>{block.columns.map((column) => <th className={`is-${column.align || 'left'}`} key={column.key}>{column.label}</th>)}</tr></thead>
            <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>
              {block.columns.map((column) => <td className={`is-${column.align || 'left'}`} key={column.key}>{String(row[column.key] ?? '—')}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
      </section>;
      if (block.kind === 'progress') {
        const max = block.max && block.max > 0 ? block.max : 100;
        const percent = Math.max(0, Math.min(100, (block.value / max) * 100));
        return <div className={`extension-progress is-${block.tone || 'accent'}`} key={index}>
          <div><strong>{block.label}</strong>{block.detail && <span>{block.detail}</span>}</div>
          <div className="extension-progress-track" role="progressbar" aria-label={block.label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={block.value}>
            <i style={{ width: `${percent}%` }} />
          </div>
        </div>;
      }
      if (block.kind === 'emptyState') return <div className="extension-empty" key={index}>
        <span><CircleEllipsis /></span>
        <strong>{block.title}</strong>
        {block.text && <p>{block.text}</p>}
        {block.action && <button
          type="button"
          className={`extension-action is-${block.action.tone || 'default'}`}
          disabled={busyButton !== null}
          onClick={() => onAction(block.action!.action)}
        >{block.action.label}</button>}
      </div>;
      if (block.kind === 'dataView') {
        return <LiveDataView
          key={index}
          block={block}
          busyButton={busyButton}
          onAction={onAction}
          depth={depth}
          cwd={cwd}
          sessionId={sessionId}
          modelRef={modelRef}
          compact={compact}
        />;
      }
      return <div className="extension-actions" key={index}>{block.buttons.map((button) => (
        <button
          type="button"
          className={`extension-action is-${button.tone || 'default'}`}
          key={button.id}
          disabled={busyButton !== null}
          onClick={() => onAction(button.action)}
        >
          {busyButton === button.id ? <span className="extension-action-spinner" /> : null}
          {button.label}
        </button>
      ))}</div>;
    })}
  </div>;
}

function ExtensionTabs({ block, busyButton, onAction, depth, cwd, sessionId, modelRef }: {
  block: Extract<ExtensionContent, { kind: 'tabs' }>;
  busyButton: string | null;
  onAction: (action: ExtensionUiAction) => void;
  depth: number;
  cwd?: string;
  sessionId?: string;
  modelRef?: string;
}) {
  const initial = block.tabs.some((tab) => tab.id === block.activeTab) ? block.activeTab! : block.tabs[0]?.id;
  const [active, setActive] = useState(initial);
  const selected = block.tabs.find((tab) => tab.id === active) || block.tabs[0];
  if (!selected) return null;
  return <div className="extension-tabs">
    <div className="extension-tab-list" role="tablist">
      {block.tabs.map((tab) => <button
        type="button"
        role="tab"
        aria-selected={tab.id === selected.id}
        className={tab.id === selected.id ? 'is-active' : ''}
        key={tab.id}
        onClick={() => setActive(tab.id)}
      >{tab.label}</button>)}
    </div>
    <div className="extension-tab-panel" role="tabpanel">
      <ContentBlocks blocks={selected.content} busyButton={busyButton} onAction={onAction} depth={depth} cwd={cwd} sessionId={sessionId} modelRef={modelRef} />
    </div>
  </div>;
}

export function ExtensionSlot({
  slot,
  hostGlobalPanels = false,
  cwd,
  sessionId,
  modelRef,
  onOpenSettings,
  onSendPrompt,
  onNotify,
  snapshot,
  selectedItemId,
  presentation = 'cards',
}: ExtensionSlotProps) {
  const loadedSnapshot = useExtensionUiSnapshot(cwd, !snapshot);
  const [dialog, setDialog] = useState<ExtensionUiItem | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const surface = snapshot ?? loadedSnapshot;

  useEffect(() => {
    if (!dialog) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDialog(null);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [dialog]);

  useEffect(() => {
    if (!hostGlobalPanels) return;
    const openPanel = (event: Event) => {
      const panelId = (event as CustomEvent<{ panelId?: unknown }>).detail?.panelId;
      if (typeof panelId !== 'string' || !panelId) return;
      const target = surface.items.find((item) => item.id === panelId);
      if (target) {
        setDialog(target);
        return;
      }
      onNotify?.({ message: '这个扩展面板当前不可用。', tone: 'warning' });
    };
    window.addEventListener('pi-studio:open-extension-panel', openPanel);
    return () => window.removeEventListener('pi-studio:open-extension-panel', openPanel);
  }, [hostGlobalPanels, onNotify, surface]);

  const items = useMemo(
    () => surface.items
      .filter((item) => item.slot === slot)
      .filter((item) => !selectedItemId || item.id === selectedItemId)
      .sort((left, right) => (
        right.priority - left.priority || left.sourceOrder - right.sourceOrder
      )),
    [selectedItemId, slot, surface],
  );

  async function runCommand(commandId: string, actionDepth = 0): Promise<void> {
    const result: ExtensionCommandResult = await window.piApi.runExtensionCommand({
      commandId,
      sessionId,
      cwd,
    });
    if (result.action) {
      if (actionDepth >= MAX_ACTION_CHAIN) {
        throw new Error('扩展操作链过深，已停止继续执行');
      }
      await applyAction(result.action, actionDepth + 1);
      return;
    }
    if (result.promptText) onSendPrompt?.(result.promptText, Boolean(result.submit));
    if (result.settingsPage) onOpenSettings?.(result.settingsPage);
    if (result.panelId) {
      const target = surface.items.find((item) => item.id === result.panelId);
      if (target) setDialog(target);
      else onNotify?.({ message: '扩展要打开的面板当前不可用。', tone: 'warning' });
    }
    if (result.message) onNotify?.({ message: result.message });
  }

  async function applyAction(action: ExtensionUiAction, actionDepth = 0): Promise<void> {
    if (action.kind === 'openSettings') {
      onOpenSettings?.(action.panel);
      return;
    }
    if (action.kind === 'openPanel') {
      const target = surface.items.find((item) => item.id === action.panelId);
      if (target) setDialog(target);
      else onNotify?.({ message: '这个扩展面板当前不可用。', tone: 'warning' });
      return;
    }
    if (action.kind === 'sendPrompt') {
      onSendPrompt?.(action.text, Boolean(action.submit));
      return;
    }
    if (action.kind === 'copyText') {
      await navigator.clipboard.writeText(action.text);
      onNotify?.({ message: '已复制到剪贴板。', tone: 'success' });
      return;
    }
    if (action.kind === 'openUrl') {
      await window.piApi.openExternal(action.url);
      return;
    }
    if (action.kind === 'runCommand') {
      await runCommand(action.commandId, actionDepth);
      return;
    }
    throw new Error('扩展返回了不受支持的操作');
  }

  async function activate(buttonId: string, action: ExtensionUiAction) {
    if (activeAction) return;
    setActiveAction(buttonId);
    try {
      await applyAction(action);
    } catch (error) {
      onNotify?.({
        message: error instanceof Error ? error.message : String(error),
        tone: 'error',
      });
    } finally {
      setActiveAction(null);
    }
  }

  if (items.length === 0 && !dialog) {
    if (presentation === 'page') {
      return <div className="extension-page-empty">
        <Plug />
        <strong>这个扩展面板暂时不可用</strong>
        <span>它可能已被停用、移除，或仍在加载。</span>
      </div>;
    }
    return null;
  }
  const contentProps = {
    busyButton: activeAction,
    cwd,
    sessionId,
    modelRef,
  };
  return <>
    {presentation === 'page' && items[0] && <section className="extension-page" aria-label={items[0].title}>
      <header className="extension-page-head">
        <span className="extension-page-icon"><Plug /></span>
        <span className="extension-page-title">
          <span className="extension-slot-source">{items[0].scope === 'project' ? '项目扩展' : items[0].scope === 'user' ? '用户扩展' : '内置扩展'}</span>
          <strong>{items[0].title}</strong>
          {items[0].description && <small>{items[0].description}</small>}
        </span>
      </header>
      <div className="extension-page-body">
        <ContentBlocks
          blocks={items[0].content}
          {...contentProps}
          onAction={(action) => void activate(`page:${items[0].id}`, action)}
        />
      </div>
    </section>}
    {presentation === 'inline' && items[0] && <div className="extension-inline-content" aria-label={items[0].title}>
      <ContentBlocks
        blocks={items[0].content}
        {...contentProps}
        onAction={(action) => void activate(`inline:${items[0].id}`, action)}
      />
    </div>}
    {presentation === 'compact' && items[0] && <div className="extension-compact-slot" aria-label={items[0].title}>
      <ContentBlocks
        blocks={items[0].content}
        {...contentProps}
        compact
        onAction={(action) => void activate(`compact:${items[0].id}`, action)}
      />
    </div>}
    {presentation === 'cards' && items.length > 0 && <section className={`extension-slot is-${slot.replaceAll('.', '-')}`} aria-label="扩展内容">
      {items.map((item) => <article className={`extension-slot-card is-${item.size}`} key={item.id}>
        <header className="extension-slot-head">
          <span className="extension-slot-icon"><Plug /></span>
          <span className="extension-slot-title">
            <strong>{item.title}</strong>
            {item.description && <small>{item.description}</small>}
          </span>
          <span className="extension-slot-source" title={`${item.scope}:${item.extensionName}`}>
            {item.scope === 'project' ? '项目' : item.scope === 'user' ? '用户' : '内置'}
          </span>
        </header>
        <ContentBlocks
          blocks={item.content}
          {...contentProps}
          onAction={(action) => void activate(`slot:${item.id}`, action)}
        />
      </article>)}
    </section>}
    {dialog && <div className="extension-panel-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setDialog(null);
    }}>
      <section className="extension-panel-dialog" role="dialog" aria-modal="true" aria-label={dialog.title}>
        <header className="extension-panel-dialog-head">
          <div>
            <span className="extension-slot-source">{dialog.scope === 'project' ? '项目扩展' : dialog.scope === 'user' ? '用户扩展' : '内置扩展'}</span>
            <h2>{dialog.title}</h2>
            {dialog.description && <p>{dialog.description}</p>}
          </div>
          <button type="button" className="extension-panel-close" aria-label="关闭扩展面板" onClick={() => setDialog(null)}><X /></button>
        </header>
        <div className="extension-panel-dialog-body">
          <ContentBlocks
            blocks={dialog.content}
            {...contentProps}
            onAction={(action) => void activate(`dialog:${dialog.id}`, action)}
          />
        </div>
        <footer className="extension-panel-dialog-foot">
          <span>{dialog.id}</span>
          <button type="button" onClick={() => setDialog(null)}><Check />完成</button>
        </footer>
      </section>
    </div>}
  </>;
}
