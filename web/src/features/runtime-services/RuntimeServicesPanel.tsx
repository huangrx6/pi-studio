import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import type {
  RuntimeService,
  RuntimeServiceOwnership,
  RuntimeServiceSnapshot,
} from '../../types/runtime-panel-types';
import { errorText } from '../../shared/error-text';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import './runtime-services-panel.css';

const OWNERSHIP_LABEL: Record<RuntimeServiceOwnership, string> = {
  agent: '任务进程',
  workspace: '工作区',
  app: 'Studio',
  other: '本机',
};

function relativeDuration(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时`;
  return `${Math.floor(seconds / 86_400)} 天`;
}

function freshLabel(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds <= 2) return '刚刚';
  return `${seconds} 秒前`;
}

function ServiceRow({
  service,
  copied,
  terminating,
  stopBusy,
  onCopy,
  onStop,
  showOwnership,
}: {
  service: RuntimeService;
  copied: boolean;
  terminating: boolean;
  stopBusy: boolean;
  onCopy: () => void;
  onStop: () => void;
  showOwnership: boolean;
}) {
  const canStop = service.canStop && service.startedAt !== undefined;
  const duration = relativeDuration(service.elapsedSeconds);
  const details = [service.url, service.command, service.cwd, ...service.evidence].filter(Boolean).join('\n');
  return <article className={`runtime-service-row is-${service.ownership} ${terminating ? 'is-terminating' : ''}`}>
    <button
      type="button"
      className="runtime-service-open"
      aria-label={`在浏览器打开 ${service.url}`}
      title={details}
      onClick={() => void window.piApi.openExternal(service.url)}
    >
      <span className="runtime-service-main">
        <span className="runtime-service-title">
          <strong className="runtime-service-port">{service.port}</strong>
          <span className="runtime-service-name">{service.processName}</span>
        </span>
        <span className="runtime-service-context">
          <span>PID {service.pid}</span>
          {duration && <span>{duration}</span>}
          {showOwnership && <span>{OWNERSHIP_LABEL[service.ownership]}</span>}
        </span>
      </span>
    </button>
    <span className="runtime-service-actions">
      <button
        type="button"
        className="runtime-service-copy"
        aria-label={`复制 ${service.url}`}
        title={copied ? '已复制' : '复制地址'}
        onClick={onCopy}
      >
        {copied ? <Check /> : <Copy />}
      </button>
      <button
        type="button"
        className="runtime-service-stop"
        aria-label={`终止 ${service.processName}，PID ${service.pid}`}
        title={canStop ? '终止服务' : service.stopBlockedReason || '缺少进程启动时间，无法安全终止'}
        aria-disabled={stopBusy || !canStop}
        onClick={() => { if (canStop && !stopBusy) onStop(); }}
      >
        {terminating && <LoaderCircle className="spin" />}
        <span>{terminating ? '终止中' : '终止'}</span>
      </button>
    </span>
  </article>;
}

type Props = { cwd?: string; workspace?: string };

export function RuntimeServicesPanel(props: Props) {
  // A workspace switch starts a fresh projection and confirmation lifetime.
  // In-flight work from an old root cannot delay or populate the new root.
  return <RuntimeServicesScope key={JSON.stringify([props.cwd || '', props.workspace || ''])} {...props} />;
}

function RuntimeServicesScope({ cwd, workspace }: Props) {
  const [snapshot, setSnapshot] = useState<RuntimeServiceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopError, setStopError] = useState<{ service: RuntimeService; message: string } | null>(null);
  const [view, setView] = useState<'task' | 'all'>('task');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [terminatingPid, setTerminatingPid] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  const copyRequestRef = useRef(0);
  const copyTimerRef = useRef<number | undefined>();
  const busyRef = useRef(false);
  const stoppingRef = useRef(false);
  const actionConfirmation = useActionConfirmation();
  const roots = useMemo(() => [...new Set([cwd, workspace].filter(Boolean))] as string[], [cwd, workspace]);

  const scan = useCallback(async (initial = false, replace = false) => {
    if (!mountedRef.current) return;
    if (replace) {
      // A completed stop invalidates pre-stop data even if the window became
      // hidden; the next visible scan must not wait behind that obsolete read.
      requestRef.current += 1;
      busyRef.current = false;
    }
    if (document.hidden || busyRef.current) return;
    busyRef.current = true;
    const request = ++requestRef.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      const next = await window.piApi.runtimeServices({ cwd, roots });
      if (!mountedRef.current || request !== requestRef.current) return;
      setSnapshot(next);
      setError(null);
      setClock(Date.now());
    } catch (cause) {
      if (mountedRef.current && request === requestRef.current) setError(errorText(cause));
    } finally {
      if (mountedRef.current && request === requestRef.current) {
        busyRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [cwd, roots]);

  useEffect(() => {
    mountedRef.current = true;
    let refresh: number | undefined;
    let tick: number | undefined;
    const clearTimers = () => { window.clearInterval(refresh); window.clearInterval(tick); };
    const onVisibility = () => {
      clearTimers();
      if (document.hidden) return;
      setClock(Date.now());
      void scan(false);
      refresh = window.setInterval(() => void scan(false), 2_500);
      tick = window.setInterval(() => setClock(Date.now()), 1_000);
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      busyRef.current = false;
      copyRequestRef.current += 1;
      window.clearTimeout(copyTimerRef.current);
      clearTimers();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [scan]);

  const services = snapshot?.services ?? [];
  // Studio's own listeners belong in "all"; keeping them out of "task" makes
  // the default view answer the task-specific question instead of the host
  // application's process tree question.
  const visibleServices = view === 'task'
    ? services.filter((service) => service.ownership === 'agent' || service.ownership === 'workspace')
    : services;
  const taskCount = snapshot?.summary.related ?? 0;
  const allCount = snapshot?.summary.total ?? 0;
  const portsByPid = useMemo(() => {
    const ports = new Map<number, number[]>();
    for (const service of services) {
      const current = ports.get(service.pid) || [];
      current.push(service.port);
      ports.set(service.pid, current);
    }
    return ports;
  }, [services]);

  async function copyAddress(service: RuntimeService) {
    const request = ++copyRequestRef.current;
    try {
      await navigator.clipboard.writeText(service.url);
      if (!mountedRef.current || request !== copyRequestRef.current) return;
      window.clearTimeout(copyTimerRef.current);
      setActionError(null);
      setCopiedId(service.id);
      copyTimerRef.current = window.setTimeout(() => setCopiedId(null), 1_400);
    } catch {
      if (mountedRef.current && request === copyRequestRef.current) setActionError('复制失败，请检查剪贴板权限');
    }
  }

  async function stopService(service: RuntimeService) {
    if (!mountedRef.current || stoppingRef.current || !service.canStop || service.startedAt === undefined) return;
    stoppingRef.current = true;
    setStopBusy(true);
    const affectedPorts = [...new Set(portsByPid.get(service.pid) || [service.port])]
      .sort((left, right) => left - right);
    const affectedText = affectedPorts.length > 1
      ? `同一进程还在监听端口 ${affectedPorts.join('、')}，也会一起停止。`
      : `将停止端口 ${service.port} 并断开它当前的连接。`;
    const accepted = await actionConfirmation.confirm({
      title: `终止 ${service.processName}？`,
      description: `${service.ownership === 'other' ? '这是当前工作区以外的本机服务。' : ''}将结束 PID ${service.pid}。${affectedText}如果进程没有及时退出，Studio 会强制结束它。`,
      confirmLabel: '终止服务',
      tone: 'danger',
    });
    if (!mountedRef.current) return;
    if (!accepted) { stoppingRef.current = false; setStopBusy(false); return; }

    setTerminatingPid(service.pid);
    setStopError(null);
    try {
      await window.piApi.runtimeServiceStop({
        pid: service.pid,
        port: service.port,
        startedAt: service.startedAt,
      });
      if (!mountedRef.current) return;
      setError(null);
      await scan(false, true);
    } catch (cause) {
      // Polling can recover a scan error, but must not erase a failed stop.
      if (mountedRef.current) setStopError({ service, message: errorText(cause) });
    } finally {
      if (mountedRef.current) {
        stoppingRef.current = false;
        setStopBusy(false);
        setTerminatingPid(null);
      }
    }
  }

  return <>
    <section className="runtime-services-panel" aria-label="运行服务">
    <header className="runtime-services-toolbar">
      <span className={`runtime-services-live ${error ? 'is-stale' : ''}`}>
        <i aria-hidden="true" />
        {refreshing || loading ? '正在扫描' : error ? '扫描失败' : snapshot ? freshLabel(snapshot.scannedAt, clock) : '等待扫描'}
      </span>
      <div className="runtime-services-scope" role="group" aria-label="服务范围">
        <button type="button" aria-pressed={view === 'task'} onClick={() => setView('task')}>
          任务<span>{taskCount}</span>
        </button>
        <button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')}>
          全部<span>{allCount}</span>
        </button>
      </div>
      <button
        type="button"
        className="runtime-services-refresh"
        aria-label="刷新运行服务"
        title="刷新"
        disabled={refreshing || loading}
        onClick={() => void scan(false)}
      >
        <RefreshCw className={refreshing ? 'spin' : undefined} />
      </button>
    </header>

    {snapshot?.warning && <div className="runtime-services-notice">{snapshot.warning}</div>}
    {error && <div className="runtime-services-error" role="alert">
      <span>{error}{snapshot && <small>以下显示上次扫描结果</small>}</span>
      <button type="button" onClick={() => void scan(false)}>重试</button>
    </div>}
    {actionError && <div className="runtime-services-error" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError(null)}>关闭</button></div>}
    {stopError && <div className="runtime-services-error" role="alert">
      <span>{stopError.message}</span>
      <button type="button" disabled={stopBusy} onClick={() => void stopService(stopError.service)}>重新终止</button>
      <button type="button" onClick={() => setStopError(null)}>关闭</button>
    </div>}

    <div className="runtime-services-list">
      {loading && visibleServices.length === 0 && <div className="runtime-services-skeletons" aria-label="正在扫描监听端口">
        {[0, 1, 2].map((item) => <span key={item} />)}
      </div>}
      {!loading && visibleServices.map((service) => <ServiceRow
        key={service.id}
        service={service}
        copied={copiedId === service.id}
        terminating={terminatingPid === service.pid}
        stopBusy={stopBusy}
        showOwnership={view === 'all'}
        onCopy={() => void copyAddress(service)}
        onStop={() => void stopService(service)}
      />)}
      {!loading && !error && snapshot && visibleServices.length === 0 && snapshot.supported !== false && <div className="runtime-services-empty">
        <Activity aria-hidden="true" />
        <strong>{view === 'task' ? '当前任务还没有监听服务' : '没有发现监听端口'}</strong>
        {view === 'task' && allCount > 0 && <button type="button" onClick={() => setView('all')}>查看本机其他服务</button>}
      </div>}
    </div>
    </section>
    {actionConfirmation.dialog}
  </>;
}
