import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Gauge, RefreshCw, X } from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import { errorText } from '../../shared/error-text';
import type { ProviderQuotaSnapshot } from '../../types/provider-quota';
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

function quotaNotice(snapshot: ProviderQuotaSnapshot) {
  if (snapshot.status === 'disabled') return '此来源的额度监控已关闭。';
  if (snapshot.status === 'unmapped') return '返回值与映射不匹配，请检查字段路径和显示格式。';
  return snapshot.message;
}

export function ProviderQuotaMenuRow({ id, name, onOpen }: { id: string; name: string; onOpen: () => void }) {
  const { snapshot } = useProviderQuota(id);
  const summary = snapshot?.metrics.filter(item => item.summary && item.value !== null).map(item => `${item.label} ${item.value}`).join(' · ');
  const fallback = snapshot && (snapshot.status === 'ready' || snapshot.status === 'stale' ? `查看全部 ${snapshot.metrics.length} 项额度` : quotaNotice(snapshot));
  return <button type="button" className="workspace-menu-row quota-menu-row" onClick={onOpen} aria-label={`查看 ${name} 额度`}>
    <span className="workspace-menu-row-icon"><Gauge aria-hidden="true" /></span>
    <span className="quota-menu-copy"><strong>{name} 额度</strong>
      {!snapshot ? <LoadingState>正在查询额度</LoadingState> : <small>{snapshot.status === 'stale' && '上次读数 · '}{summary || fallback}</small>}
    </span><ChevronRight className="workspace-menu-row-arrow" aria-hidden="true" />
  </button>;
}

export function ProviderQuotaDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const { snapshot, busy, read } = useProviderQuota(id);
  const notice = snapshot && quotaNotice(snapshot);
  return <DetailDialog className="provider-quota-dialog" onClose={onClose}>
    <header className="detail-header"><div className="detail-heading"><span className="detail-icon"><Gauge /></span>
      <div><h2>额度监控</h2><p>{name}</p></div></div>
      <button type="button" className="icon-button" aria-label="关闭额度详情" onClick={onClose}><X /></button></header>
    <div className="quota-detail-body">
      {!snapshot && <LoadingState variant="panel">正在查询额度</LoadingState>}
      {notice && <p className="quota-detail-notice" role="status">{notice}</p>}
      {snapshot && snapshot.metrics.length > 0 && <dl className="quota-detail-metrics">
        {snapshot.metrics.map((metric, i) => <div key={i}><dt>{metric.label}</dt><dd>{metric.value ?? <small>{metric.issue}</small>}</dd>
          {metric.percent !== undefined && <progress aria-label={metric.label} max={100} value={metric.percent} />}
        </div>)}
      </dl>}
    </div>
    <footer className="quota-detail-footer"><span>{snapshot?.updatedAt ? `${snapshot.status === 'stale' ? '上次成功' : '更新于'} ${new Date(snapshot.updatedAt).toLocaleTimeString()}` : ''}</span>
      <button type="button" className="settings-outline" disabled={busy || snapshot?.status === 'disabled'} onClick={() => void read(true)}>
        {busy ? <LoadingIndicator /> : <RefreshCw />}刷新额度
      </button></footer>
  </DetailDialog>;
}
