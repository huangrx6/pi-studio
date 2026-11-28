import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  Check,
  Copy,
  RefreshCw,
  Plug,
  X,
} from 'lucide-react';
import { PopoverSurface } from '../../shared/PopoverSurface';
import { useStatusBarPopover } from '../../shared/useStatusBarPopover';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import type {
  RuntimeService,
  RuntimeServiceOwnership,
  RuntimeServiceSnapshot,
} from '../../types/runtime-panel-types';
import { errorText } from '../../shared/error-text';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import './styles/runtime-services-panel.css';

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

function ServiceRow({
  service,
  copied,
  terminating,
  stopBusy,
  onCopy,
  onOpen,
  onStop,
  showOwnership,
}: {
  service: RuntimeService;
  copied: boolean;
  terminating: boolean;
  stopBusy: boolean;
  onCopy: () => void;
  onOpen: () => void;
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
      onClick={onOpen}
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
        {terminating && <LoadingIndicator />}
        <span>{terminating ? '终止中' : '终止'}</span>
      </button>
    </span>
  </article>;
}

function ServicesPopover({ open, onOpenChange, count, loading, children }: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  count: number | null;
  loading: boolean;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const { surface, rendered, phase } = useStatusBarPopover(open ? children : undefined);
  const id = useId();
  const close = () => { onOpenChange(false); trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!open || !surface.current || !trigger.current) return;
    const panel = surface.current;
    const button = trigger.current;
    const position = () => {
      const rect = button.getBoundingClientRect();
      panel.style.bottom = `${window.innerHeight - rect.top + 5}px`;
      panel.style.right = `${Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.maxHeight = `${Math.max(0, rect.top - 14)}px`;
    };
    position();
    panel.focus({ preventScroll: true });
    const dismissOutside = (event: Event) => {
      const node = event.target;
      if (!(node instanceof Node) || panel.contains(node) || button.contains(node)) return;
      // The stop confirmation lives in a native modal above the popover.
      if (node instanceof Element && node.closest('dialog[open]')?.querySelector('.runtime-service-confirm')) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside);
    window.addEventListener('resize', position);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside);
      window.removeEventListener('resize', position);
    };
  }, [open, onOpenChange, surface]);
  return <>
    <button type="button" ref={trigger} className="runtime-status-trigger" aria-busy={loading}
      aria-label={count === null ? '运行服务' : `运行服务，${count} 个相关服务`}
      title={count === null ? '查看正在运行的服务' : `查看运行服务，当前有 ${count} 个相关服务`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onKeyDown={event => {
        if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onOpenChange(false); }
      }}
      onClick={() => onOpenChange(!open)}>
      <Plug aria-hidden="true" /><span>相关服务</span><span>{count ?? '–'}</span>
    </button>
    {rendered && <PopoverSurface topLayer ref={surface} id={id} className="runtime-status-popover" data-status-popover={phase}
      role="dialog" aria-label="运行服务" tabIndex={-1} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      <header className="runtime-status-heading">
        <h2>运行服务</h2>
        <button type="button" className="icon-button" aria-label="关闭运行服务" onClick={close}><X /></button>
      </header>
      {rendered}
    </PopoverSurface>}
  </>;
}

type Props = { cwd?: string; workspace?: string };

export function RuntimeServicesStatus(props: Props) {
  // A workspace switch starts a fresh projection and confirmation lifetime.
  // In-flight work from an old root cannot delay or populate the new root.
  return <RuntimeServicesScope key={JSON.stringify([props.cwd || '', props.workspace || ''])} {...props} />;
}

function RuntimeServicesScope({ cwd, workspace }: Props) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<RuntimeServiceSnapshot | null>(null);
  const [manualRefresh, setManualRefresh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopError, setStopError] = useState<{ service: RuntimeService; message: string } | null>(null);
  const [view, setView] = useState<'task' | 'all'>('task');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [terminatingPid, setTerminatingPid] = useState<number | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  const copyRequestRef = useRef(0);
  const copyTimerRef = useRef<number | undefined>();
  const busyRef = useRef(false);
  const stoppingRef = useRef(false);
  const actionConfirmation = useActionConfirmation('runtime-service-confirm');
  const roots = useMemo(() => [...new Set([cwd, workspace].filter(Boolean))] as string[], [cwd, workspace]);

  const scan = useCallback(async (reason: 'automatic' | 'manual' | 'after-stop' = 'automatic') => {
    if (!mountedRef.current) return;
    if (reason === 'after-stop') {
      // A completed stop invalidates pre-stop data even if the window became
      // hidden; the next visible scan must not wait behind that obsolete read.
      requestRef.current += 1;
      busyRef.current = false;
      setManualRefresh(false);
    }
    if (document.hidden) return;
    if (reason === 'manual') setManualRefresh(true);
    if (busyRef.current) return;
    busyRef.current = true;
    const request = ++requestRef.current;
    try {
      const next = await window.piApi.runtimeServices({ cwd, roots });
      if (!next?.summary || !Array.isArray(next.services)) throw new Error('无法读取运行服务状态');
      if (!mountedRef.current || document.hidden || request !== requestRef.current) return;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (mountedRef.current && request === requestRef.current) setError(errorText(cause));
    } finally {
      if (mountedRef.current && request === requestRef.current) {
        busyRef.current = false;
        setManualRefresh(false);
      }
    }
  }, [cwd, roots]);

  useEffect(() => {
    mountedRef.current = true;
    void scan();
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      busyRef.current = false;
      copyRequestRef.current += 1;
      window.clearTimeout(copyTimerRef.current);
    };
  }, [scan]);

  useEffect(() => {
    let refresh: number | undefined;
    const schedule = (scanNow: boolean) => {
      window.clearInterval(refresh);
      if (document.hidden) return;
      if (scanNow) void scan();
      refresh = window.setInterval(() => void scan(), open ? 2_500 : 15_000);
    };
    const onVisibility = () => schedule(true);
    schedule(open);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [scan, open]);

  const loading = !snapshot && error === null;
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
      await scan('after-stop');
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
    <ServicesPopover open={open} onOpenChange={setOpen} loading={loading}
      count={snapshot?.supported ? taskCount : null}>
    {open && <section className="runtime-services-panel" aria-label="监听端口">
    <header className="runtime-services-toolbar">
      <span className={`runtime-services-live ${error ? 'is-stale' : ''}`}
        data-supported={snapshot?.supported}
        title={snapshot ? `上次扫描于 ${new Date(snapshot.scannedAt).toLocaleTimeString()}` : undefined}>
        <i aria-hidden="true" />
        {error ? '扫描失败' : snapshot?.supported === false ? '暂不支持' : '自动刷新'}
      </span>
      <div className="runtime-services-scope" role="group" aria-label="服务范围">
        <button type="button" title="Studio 任务和当前项目的服务" aria-pressed={view === 'task'} onClick={() => setView('task')}>
          相关服务<span>{snapshot?.supported ? taskCount : '–'}</span>
        </button>
        <button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')}>
          本机全部<span>{snapshot?.supported ? allCount : '–'}</span>
        </button>
      </div>
      <button
        type="button"
        className="runtime-services-refresh"
        aria-label="刷新运行服务"
        title="刷新"
        aria-busy={manualRefresh}
        aria-disabled={manualRefresh}
        onClick={() => void scan('manual')}
      >
        <RefreshCw className={manualRefresh ? 'spin' : undefined} />
      </button>
    </header>

    {snapshot?.warning && <div className="runtime-services-notice">{snapshot.warning}</div>}
    {error && <div className="runtime-services-error" role="alert">
      <span>{error}{snapshot && <small>以下显示上次扫描结果</small>}</span>
      <button type="button" onClick={() => void scan('manual')}>重试</button>
    </div>}
    {actionError && <div className="runtime-services-error" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError(null)}>关闭</button></div>}
    {stopError && <div className="runtime-services-error" role="alert">
      <span>{stopError.message}</span>
      <button type="button" disabled={stopBusy} onClick={() => void stopService(stopError.service)}>重新终止</button>
      <button type="button" onClick={() => setStopError(null)}>关闭</button>
    </div>}

    <div className="runtime-services-list">
      {loading && <LoadingState variant="panel">正在读取运行服务…</LoadingState>}
      {!loading && visibleServices.map((service) => <ServiceRow
        key={service.id}
        service={service}
        copied={copiedId === service.id}
        terminating={terminatingPid === service.pid}
        stopBusy={stopBusy}
        showOwnership={view === 'all'}
        onOpen={() => { void window.piApi.openExternal(service.url).catch(cause => {
          if (mountedRef.current) setActionError(errorText(cause));
        }); }}
        onCopy={() => void copyAddress(service)}
        onStop={() => void stopService(service)}
      />)}
      {!loading && !error && snapshot && visibleServices.length === 0 && snapshot.supported !== false && <div className="runtime-services-empty">
        <Activity aria-hidden="true" />
        <strong>{view === 'task' ? '暂无相关服务' : '没有发现监听端口'}</strong>
        {view === 'task' && allCount > 0 && <button type="button" onClick={() => setView('all')}>查看本机其他服务</button>}
      </div>}
    </div>
    </section>}
    </ServicesPopover>
    {actionConfirmation.dialog}
  </>;
}
