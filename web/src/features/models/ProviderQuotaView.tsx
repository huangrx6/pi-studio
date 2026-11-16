import { useCallback, useEffect, useRef, useState } from 'react';
import { ExtensionStatusIcon } from '../extensions/ExtensionStatusIcon';
import type { StatusPanel } from '../../shared/extension-appearance';
import { ChevronRight, Gauge, RefreshCw, X } from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import { errorText } from '../../shared/error-text';
import type { ProviderQuotaSnapshot, QuotaMetric } from '../../types/provider-quota';
import './styles/provider-quota.css';

function useProviderQuota(id: string) {
  const [snapshot, setSnapshot] = useState<ProviderQuotaSnapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const request = useRef(0);
  const read = useCallback(async (refresh = false) => {
    const revision = ++request.current;
    setBusy(true);
    try {
      const value = await window.piApi.providerQuota(id, refresh);
      if (revision === request.current) setSnapshot(value);
    } catch (error) {
      if (revision === request.current) setSnapshot({ status: 'error', metrics: [], message: errorText(error) });
    } finally { if (revision === request.current) setBusy(false); }
  }, [id]);
  useEffect(() => {
    setSnapshot(null);
    const readWhenVisible = () => { if (!document.hidden) void read(); };
    readWhenVisible();
    const timer = window.setInterval(readWhenVisible, 60_000);
    document.addEventListener('visibilitychange', readWhenVisible);
    return () => { ++request.current; window.clearInterval(timer); document.removeEventListener('visibilitychange', readWhenVisible); };
  }, [read]);
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

export function ProviderQuotaMenuRow({ id, name, item, onOpen }: { id: string; name: string; item: StatusPanel; onOpen: () => void }) {
  const { snapshot } = useProviderQuota(id);
  const summary = snapshot && (snapshot.status === 'ready' || snapshot.status === 'stale'
    ? quotaSummary(snapshot.metrics) : quotaNotice(snapshot));
  return <button type="button" className="workspace-menu-row quota-menu-row" onClick={onOpen} aria-label={`查看 ${name} 额度`}>
    <span className="workspace-menu-row-icon"><ExtensionStatusIcon item={item} /></span>
    <span className="quota-menu-copy"><strong>{name} 额度</strong>
      {!snapshot ? <LoadingState>正在查询额度</LoadingState> : <small>{snapshot.status === 'stale' && '上次读数 · '}{summary}</small>}
    </span><ChevronRight className="workspace-menu-row-arrow" aria-hidden="true" />
  </button>;
}

export function QuotaMetricList({ metrics }: { metrics: QuotaMetric[] }) {
  return <dl className="quota-detail-metrics">
    {metrics.map((metric, i) => <div key={i}><dt>{metric.label}</dt><dd>{metric.value ?? <small>{metric.issue}</small>}</dd>
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
  const { snapshot } = useProviderQuota(id);
  return <QuotaMetrics snapshot={snapshot} />;
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
