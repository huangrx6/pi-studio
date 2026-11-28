import { useCallback, useEffect, useRef, useState } from 'react';
import { ExtensionStatusIcon } from '../extensions/ExtensionStatusIcon';
import type { StatusPanel } from '../../shared/extension-appearance';
import { CircleAlert, Gauge, RefreshCw, X } from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import { errorText } from '../../shared/error-text';
import type { ProviderQuotaSnapshot, QuotaMetric } from '../../types/provider-quota';
import { useSurfaceActive } from '../../shared/surface-visibility';
import './styles/provider-quota.css';

function useProviderQuota(id: string) {
  const active = useSurfaceActive();
  const [snapshot, setSnapshot] = useState<ProviderQuotaSnapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const request = useRef(0);
  const read = useCallback(async (refresh = false) => {
    const revision = ++request.current;
    setBusy(true);
    try {
      const value = await window.piApi.providerQuota(id, refresh);
      if (revision === request.current) {
        setSnapshot(value);
        if (refresh) window.dispatchEvent(new CustomEvent('pi-studio:quota-refreshed', { detail: { id, snapshot: value } }));
      }
    } catch (error) {
      if (revision === request.current) setSnapshot({ status: 'error', metrics: [], message: errorText(error) });
    } finally { if (revision === request.current) setBusy(false); }
  }, [id]);
  useEffect(() => {
    const readWhenVisible = () => { if (active && !document.hidden) void read(); };
    const unsubscribe = window.piApi.onProviderQuotaInvalidated(changedId => {
      if (changedId !== id) return;
      ++request.current;
      setSnapshot(null);
      setBusy(true);
      readWhenVisible();
    });
    if (!active) return unsubscribe;
    const onRefreshed = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; snapshot: ProviderQuotaSnapshot }>).detail;
      if (detail?.id !== id) return;
      ++request.current;
      setSnapshot(detail.snapshot);
      setBusy(false);
    };
    document.addEventListener('visibilitychange', readWhenVisible);
    window.addEventListener('pi-studio:quota-refreshed', onRefreshed);
    readWhenVisible();
    const timer = window.setInterval(readWhenVisible, 60_000);
    return () => {
      ++request.current;
      unsubscribe();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', readWhenVisible);
      window.removeEventListener('pi-studio:quota-refreshed', onRefreshed);
    };
  }, [active, id, read]);
  return { snapshot, busy, read };
}

const noMappedFields = '返回值与映射不匹配，请检查字段路径和显示格式。';
function quotaNotice(snapshot: ProviderQuotaSnapshot) {
  if (snapshot.status === 'disabled') return '此来源的额度监控已关闭。';
  if (snapshot.status === 'unmapped') return noMappedFields;
  if (snapshot.status === 'error') return snapshot.message || '额度查询失败，请重试。';
  if (snapshot.status === 'stale') return snapshot.message || '暂时无法更新，显示上次成功的读数。';
  return snapshot.message;
}

// A configured field may use a currency symbol as its entire label. Keep that
// currency when the API value is unitless, or use the unit already mapped.
function displayMetric({ label, value }: QuotaMetric) {
  const currencyLabel = /^\p{Sc}$/u.test(label.trim());
  const reading = value?.match(/^([+-]?[\d,]+(?:\.\d+)?)\s*(\p{Sc})$/u);
  if (reading) value = reading[2] + reading[1];
  else if (currencyLabel && value && /^[+-]?[\d,]+(?:\.\d+)?$/.test(value)) value = label.trim() + value;
  return { label: currencyLabel ? '余额' : label, value };
}

export function quotaSummary(metrics: QuotaMetric[]) {
  if (!metrics.some(metric => metric.value !== null)) return noMappedFields;
  return metrics.filter(metric => metric.summary && metric.value !== null).map(displayMetric).map(metric => `${metric.label} ${metric.value}`).join(' · ') || `查看全部 ${metrics.length} 项额度`;
}

export function ProviderQuotaInline({ id, name }: { id: string; name: string }) {
  const { snapshot, busy } = useProviderQuota(id);
  const text = snapshot && (snapshot.status === 'ready' || snapshot.status === 'stale'
    ? quotaSummary(snapshot.metrics) : quotaNotice(snapshot));
  const label = text || (snapshot ? '额度待更新' : '正在查询额度');
  return <span aria-busy={!snapshot && busy} title={`${name} · ${label}`}>{label}</span>;
}

export function ProviderQuotaStatus({ id, name, item }: { id: string; name: string; item: StatusPanel }) {
  const [open, setOpen] = useState(false);
  return <div className="extension-summaries is-statusbar" role="group" aria-label="临时对话额度">
    <button type="button" className="extension-summary-item" aria-haspopup="dialog"
      aria-label={`查看 ${name} 额度详情`} onClick={() => setOpen(true)}>
      <ExtensionStatusIcon item={item} />
      <span className="extension-summary-content"><ProviderQuotaInline id={id} name={name} /></span>
    </button>
    {open && <ProviderQuotaDialog id={id} name={name} item={item} onClose={() => setOpen(false)} />}
  </div>;
}

export function QuotaMetricList({ metrics, emphasize = false }: { metrics: QuotaMetric[]; emphasize?: boolean }) {
  const featured = emphasize ? metrics.filter(metric => metric.summary && metric.value !== null).slice(0, 2) : [];
  if (emphasize && !featured.length) {
    const first = metrics.find(metric => metric.value !== null);
    if (first) featured.push(first);
  }
  const ordered = featured.length ? [...featured, ...metrics.filter(metric => !featured.includes(metric))] : metrics;
  return <dl className={`quota-detail-metrics${emphasize ? ' quota-readings' : ''}`} data-featured-count={featured.length}>
    {ordered.map((metric, index) => {
      const { label, value } = displayMetric(metric);
      return <div key={index} className={index < featured.length ? 'quota-featured' : undefined}>
        <dt title={metric.label}>{label}</dt>
        <dd>{value ?? <small>{metric.issue || '暂无数据'}</small>}</dd>
        {metric.percent !== undefined && <progress aria-label={label} max={100} value={metric.percent} />}
      </div>;
    })}
  </dl>;
}

function QuotaMetrics({ snapshot }: { snapshot: ProviderQuotaSnapshot | null }) {
  if (!snapshot) return <LoadingState variant="inline" className="quota-detail-loading">正在查询额度</LoadingState>;
  const notice = quotaNotice(snapshot);
  return <>
    {notice && <p className="quota-detail-notice" data-status={snapshot.status} role="status">
      <CircleAlert aria-hidden="true" /><span>{notice}</span>
    </p>}
    {snapshot.metrics.length > 0 && <QuotaMetricList metrics={snapshot.metrics} emphasize />}
  </>;
}

function QuotaFooter({ snapshot, busy, refresh }: {
  snapshot: ProviderQuotaSnapshot | null; busy: boolean; refresh: () => void;
}) {
  const updated = snapshot?.updatedAt ? new Date(snapshot.updatedAt) : null;
  return <footer className="quota-detail-footer">
    {updated && <span title={updated.toLocaleString()}>
      {snapshot?.status === 'stale' ? '上次成功' : '更新于'} <time dateTime={updated.toISOString()}>{updated.toLocaleTimeString()}</time>
    </span>}
    <button type="button" className="settings-outline" disabled={busy || snapshot?.status === 'disabled'} onClick={refresh}>
      {busy ? <LoadingIndicator /> : <RefreshCw aria-hidden="true" />}刷新额度
    </button>
  </footer>;
}

export function ProviderQuotaPanel({ id }: { id: string }) {
  const { snapshot, busy, read } = useProviderQuota(id);
  return <div className="provider-quota-panel">
    <div className="quota-detail-body"><QuotaMetrics snapshot={snapshot} /></div>
    <QuotaFooter snapshot={snapshot} busy={busy} refresh={() => void read(true)} />
  </div>;
}

export function ProviderQuotaDialog({ id, name, item, onClose }: { id: string; name: string; item?: StatusPanel; onClose: () => void }) {
  const { snapshot, busy, read } = useProviderQuota(id);
  return <DetailDialog className="provider-quota-dialog" onClose={onClose}>
    {close => <>
    <header className="detail-header"><div className="detail-heading"><span className="detail-icon">{item ? <ExtensionStatusIcon item={item} /> : <Gauge />}</span>
      <div><h2>额度监控</h2><p>{name}</p></div></div>
      <button type="button" className="icon-button" aria-label="关闭额度详情" onClick={close}><X /></button></header>
    <div className="quota-detail-body">
      <QuotaMetrics snapshot={snapshot} />
    </div>
    <QuotaFooter snapshot={snapshot} busy={busy} refresh={() => void read(true)} />
    </>}
  </DetailDialog>;
}
