import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Download,
  LoaderCircle,
  RefreshCw,
  Rocket,
  X,
} from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { InfoHint } from '../../shared/InfoHint';
import type { UpdateSnapshot } from '../../types/update-types';

type UpdateAction = 'check' | 'download' | 'install' | null;

function shortDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function formatBytes(value?: number): string {
  if (!Number.isFinite(value) || !value || value < 1) return '';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function titleFor(snapshot: UpdateSnapshot): string {
  if (snapshot.state === 'checking') return '正在寻找新版本';
  if (snapshot.state === 'available') return `Pi Studio ${snapshot.latestVersion || '新版本'} 已可用`;
  if (snapshot.state === 'downloading') return '正在准备更新';
  if (snapshot.state === 'downloaded') return '更新已准备好';
  if (snapshot.state === 'up-to-date') return '你正在使用最新版本';
  if (snapshot.state === 'error') return '这次没有更新成功';
  if (snapshot.state === 'unsupported') return '请使用打包版本检查更新';
  return '检查应用更新';
}

export function UpdateDialog({ snapshot, onClose, onCheck, onDownload, onInstall }: {
  snapshot: UpdateSnapshot;
  onClose: () => void;
  onCheck: () => Promise<void>;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
}) {
  const [pendingAction, setPendingAction] = useState<UpdateAction>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  async function run(action: Exclude<UpdateAction, null>, callback: () => Promise<void>) {
    if (pendingAction) return;
    setPendingAction(action);
    try {
      await callback();
    } finally {
      if (mountedRef.current) setPendingAction(null);
    }
  }

  const progress = Math.round(snapshot.progress || 0);
  const speed = snapshot.state === 'downloading' && snapshot.bytesPerSecond
    ? `${formatBytes(snapshot.bytesPerSecond)}/s`
    : '';
  const transferred = formatBytes(snapshot.transferred);
  const total = formatBytes(snapshot.total);
  const downloadedMeta = transferred && total ? `${transferred} / ${total}` : transferred;
  const latestLabel = snapshot.latestVersion ? `v${snapshot.latestVersion}` : '最新版本';
  const currentLabel = snapshot.currentVersion ? `v${snapshot.currentVersion}` : '当前版本';
  const published = shortDate(snapshot.publishedAt);
  const stateLabel = {
    idle: '准备检查',
    checking: '正在检查',
    'up-to-date': '已是最新',
    available: '发现更新',
    downloading: '下载中',
    downloaded: '等待安装',
    error: '需要重试',
    unsupported: '开发模式',
  }[snapshot.state];

  return <DetailDialog className="update-dialog" onClose={onClose}>
    <header className="update-header">
      <div className="update-heading">
        <h2>{titleFor(snapshot)}</h2>
      </div>
      <button className="update-close" type="button" aria-label="关闭更新窗口" onClick={onClose}><X /></button>
    </header>

    <div className={`update-stage is-${snapshot.state}`}>
      <div className="update-orbit" aria-hidden="true">
        <span className="update-orbit-ring is-outer" />
        <span className="update-orbit-ring is-inner" />
        <span className="update-mark">π</span>
        <span className="update-spark is-one" />
        <span className="update-spark is-two" />
      </div>
      <div className="update-version-flow" aria-label={`${currentLabel} 到 ${latestLabel}`}>
        <span>{currentLabel}</span>
        <ArrowRight />
        <strong>{latestLabel}</strong>
      </div>
      <span className={`update-status-pill is-${snapshot.state}`}>{stateLabel}</span>
    </div>

    <div className="update-body">
      {snapshot.state === 'checking' && <div className="update-checking" role="status">
        <span className="update-checking-lines" aria-hidden="true"><i /><i /><i /></span>
        <span><strong>正在读取版本信息 <InfoHint label="只公开访问 GitHub Releases，不会上传本地数据。" /></strong></span>
        <LoaderCircle className="spin" />
      </div>}

      {snapshot.state === 'downloading' && <section className="update-download" aria-label="更新下载进度">
        <div className="update-download-head">
          <span><strong>下载 Pi Studio {latestLabel}</strong><small>{downloadedMeta || '正在建立下载连接'}</small></span>
          <output>{progress}%</output>
        </div>
        <div className="update-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="update-download-foot"><span>{speed || '正在下载…'}</span><span>可以关闭窗口，下载仍会继续</span></div>
      </section>}

      {snapshot.state === 'downloaded' && <section className="update-ready-card">
        <span className="update-ready-icon"><Check /></span>
        <span><strong>安装包已经准备好</strong><small>立即安装会重启 Pi Studio；稍后会在下次正常退出时安装。</small></span>
      </section>}

      {(snapshot.state === 'available' || snapshot.state === 'downloaded') && <section className="update-notes">
        <div className="update-notes-head">
          {(snapshot.releaseName || snapshot.releaseNotes || published) && <span><strong>本次更新</strong>{published && <small>{published}</small>}</span>}
          {snapshot.releaseName && <span className="update-release-name">{snapshot.releaseName}</span>}
        </div>
        {snapshot.releaseNotes && <div className="update-notes-copy">{snapshot.releaseNotes}</div>}
      </section>}

      {(snapshot.state === 'error' || snapshot.state === 'unsupported') && <div className="update-error" role="alert">
        <span><RefreshCw /></span>
        <div><strong>{snapshot.state === 'unsupported' ? '还没有可用的更新信息' : '更新服务暂时不可用'}</strong><p>{snapshot.error}</p></div>
      </div>}

      {snapshot.state === 'up-to-date' && <div className="update-current-card">
        <span><Check /></span>
        <div><strong>{currentLabel} 已是最新版本</strong></div>
      </div>}
    </div>

    <footer className="update-footer">
      {snapshot.state === 'downloaded' ? <>
        <button type="button" className="settings-outline" onClick={onClose}>稍后，退出时安装</button>
        <button type="button" className="settings-save" disabled={pendingAction !== null} onClick={() => void run('install', onInstall)}>
          {pendingAction === 'install' ? <LoaderCircle className="spin" /> : <Rocket />}
          {pendingAction === 'install' ? '正在重启…' : '立即重启并更新'}
        </button>
      </> : snapshot.state === 'available' ? <>
        <button type="button" className="settings-outline" onClick={onClose}>稍后</button>
        <button type="button" className="settings-save" disabled={pendingAction !== null} onClick={() => void run('download', onDownload)}>
          {pendingAction === 'download' ? <LoaderCircle className="spin" /> : <Download />}
          {pendingAction === 'download' ? '正在开始…' : '下载更新'}
        </button>
      </> : snapshot.state === 'downloading' ? <>
        <button type="button" className="settings-outline" onClick={onClose}>后台继续</button>
        <button type="button" className="settings-save" disabled><LoaderCircle className="spin" />正在下载</button>
      </> : snapshot.state === 'unsupported' ? <>
        <button type="button" className="settings-outline" onClick={onClose}>关闭</button>
      </> : <>
        <button type="button" className="settings-outline" onClick={onClose}>关闭</button>
        <button type="button" className="settings-save" disabled={pendingAction !== null || snapshot.state === 'checking'} onClick={() => void run('check', onCheck)}>
          {pendingAction === 'check' || snapshot.state === 'checking' ? <LoaderCircle className="spin" /> : <RefreshCw />}
          {snapshot.state === 'checking' ? '正在检查…' : snapshot.state === 'error' ? '重新检查' : '检查更新'}
        </button>
      </>}
    </footer>
  </DetailDialog>;
}
