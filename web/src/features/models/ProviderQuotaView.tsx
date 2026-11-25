import { useCallback, useEffect, useRef, useState } from 'react';
import { ExtensionStatusIcon } from '../extensions/ExtensionStatusIcon';
import type { StatusPanel } from '../../shared/extension-appearance';
import { Gauge, RefreshCw, X } from 'lucide-react';
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
  return snapshot.message;
}

export function quotaSummary(metrics: QuotaMetric[]) {
  if (!metrics.some(metric => metric.value !== null)) return noMappedFields;
  return metrics.filter(metric => metric.summary && metric.value !== null).map(metric => `${metric.label} ${metric.value}`).join(' · ') || `查看全部 ${metrics.length} 项额度`;
}

export function ProviderQuotaSummary({ id, name }: { id: string; name: string }) {
  const { snapshot } = useProviderQuota(id);
  const metrics = snapshot?.metrics.filter(metric => metric.summary && metric.value !== null).slice(0, 2) ?? [];
  const notice = snapshot && (snapshot.status === 'ready' || snapshot.status === 'stale'
    ? quotaSummary(snapshot.metrics) : quotaNotice(snapshot));
  return <div className="provider-quota-summary">
    <div className="provider-quota-summary-source">
      <span title={name}>{name}</span>
      {snapshot?.status === 'stale' && <small>上次读数</small>}
    </div>
    {metrics.length > 0 ? <QuotaMetricList metrics={metrics} />
      : snapshot ? <p role="status">{notice || '额度待更新'}</p>
        : <LoadingState variant="inline">正在查询额度</LoadingState>}
  </div>;
}

export function QuotaMetricList({ metrics }: { metrics: QuotaMetric[] }) {
  return <dl className="quota-detail-metrics">
    {metrics.map((metric, i) => <div key={i}><dt title={metric.label}>{metric.label}</dt><dd>{metric.value ?? <small>{metric.issue}</small>}</dd>
      {metric.percent !== undefined && <progress aria-label={metric.label} max={100} value={metric.percent} />}
    </div>)}
  </dl>;
}

function QuotaMetrics({ snapshot }: { snapshot: ProviderQuotaSnapshot | null }) {
  const notice = snapshot && quotaNotice(snapshot);
  return <>
    {!snapshot && <LoadingState variant="panel">正在查询额度</LoadingState>}
    {notice && <p className="quota-detail-notice" role="status">{notice}</p>}
    {snapshot && snapshot.metrics.length > 0 && <QuotaMetricList metrics={snapshot.metrics} />}
  </>;
}

export function ProviderQuotaPanel({ id }: { id: string }) {
  const { snapshot, busy, read } = useProviderQuota(id);
  return <>
    <QuotaMetrics snapshot={snapshot} />
    <div className="provider-quota-panel-actions">
      {snapshot?.updatedAt && <span>{snapshot.status === 'stale' ? '上次成功' : '更新于'} {new Date(snapshot.updatedAt).toLocaleTimeString()}</span>}
      <button type="button" className="settings-outline" disabled={busy || snapshot?.status === 'disabled'} onClick={() => void read(true)}>
        {busy ? <LoadingIndicator /> : <RefreshCw />}刷新额度
      </button>
    </div>
  </>;
}

export function ProviderQuotaDialog({ id, name, item, onClose }: { id: string; name: string; item?: StatusPanel; onClose: () => void }) {
  const { snapshot, busy, read } = useProviderQuota(id);
  return <DetailDialog className="provider-quota-dialog" onClose={onClose}>
    <header className="detail-header"><div className="detail-heading"><span className="detail-icon">{item ? <ExtensionStatusIcon item={item} /> : <Gauge />}</span>
      <div><h2>额度监控</h2><p>{name}</p></div></div>
      <button type="button" className="icon-button" aria-label="关闭额度详情" onClick={onClose}><X /></button></header>
    <div className="quota-detail-body">
      <QuotaMetrics snapshot={snapshot} />
    </div>
    <footer className="quota-detail-footer"><span>{snapshot?.updatedAt ? `${snapshot.status === 'stale' ? '上次成功' : '更新于'} ${new Date(snapshot.updatedAt).toLocaleTimeString()}` : ''}</span>
      <button type="button" className="settings-outline" disabled={busy || snapshot?.status === 'disabled'} onClick={() => void read(true)}>
        {busy ? <LoadingIndicator /> : <RefreshCw />}刷新额度
      </button></footer>
  </DetailDialog>;
}
