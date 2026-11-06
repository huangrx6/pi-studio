import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { errorText } from '../../shared/error-text';
import type { UpdateSnapshot } from '../../types/update-types';
import { normalizeUpdateProgress } from './update-presentation';
import './update-dialog.css';

type UpdateAction = 'check' | 'download' | 'install';

function shortDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function formatBytes(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function titleFor(snapshot: UpdateSnapshot): string {
  if (snapshot.state === 'checking') return '正在检查更新';
  if (snapshot.state === 'available') return snapshot.updateKind === 'same-version' ? '发现同版本新构建' : '发现新版本';
  if (snapshot.state === 'downloading') return '正在下载更新';
  if (snapshot.state === 'downloaded') return '更新已下载';
  if (snapshot.state === 'up-to-date') return '已是最新版本';
  if (snapshot.state === 'error') return '更新未完成';
  if (snapshot.state === 'unsupported') return '当前环境不支持更新';
  return '检查应用更新';
}

export function UpdateDialog({ snapshot, onClose, onCheck, onDownload, onInstall }: {
  snapshot: UpdateSnapshot;
  onClose: () => void;
  onCheck: () => Promise<void>;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
}) {
  const [pendingAction, setPendingAction] = useState<UpdateAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pendingRef = useRef<UpdateAction | null>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function run(action: UpdateAction, callback: () => Promise<void>) {
    // Event handlers can run twice before React commits the disabled button.
    if (!mountedRef.current || pendingRef.current) return;
    pendingRef.current = action;
    setPendingAction(action);
    setActionError(null);
    try {
      await callback();
    } catch (cause) {
      if (mountedRef.current) setActionError(errorText(cause));
    } finally {
      pendingRef.current = null;
      if (mountedRef.current) setPendingAction(null);
    }
  }

  const progress = normalizeUpdateProgress(snapshot.progress);
  const speed = formatBytes(snapshot.bytesPerSecond);
  const transferred = formatBytes(snapshot.transferred);
  const total = formatBytes(snapshot.total);
  const downloadedMeta = transferred && total ? `${transferred} / ${total}` : transferred;
  const published = shortDate(snapshot.publishedAt);
  const showRelease = ['available', 'downloading', 'downloaded'].includes(snapshot.state);
  const sameVersionBuild = showRelease && snapshot.updateKind === 'same-version';
  const latestVersion = showRelease && snapshot.latestVersion;
  const snapshotError = (snapshot.state === 'error' || snapshot.state === 'unsupported') && snapshot.error;
  const visibleError = actionError || snapshotError;

  return <DetailDialog className="update-dialog" onClose={onClose}>
    <header className="update-header">
      <h2 aria-live="polite">{titleFor(snapshot)}</h2>
      <button className="icon-button update-close" type="button" aria-label="关闭更新窗口" onClick={onClose}><X /></button>
    </header>

    <div className="update-body">
      <dl className="update-versions">
        <div><dt>当前版本</dt><dd>{snapshot.currentVersion ? `v${snapshot.currentVersion}` : '未知'}</dd></div>
        {latestVersion && !sameVersionBuild && <div><dt>新版本</dt><dd>v{latestVersion}</dd></div>}
        {sameVersionBuild && <>
          <div><dt>当前构建</dt><dd><code>{snapshot.currentBuildId || '未知'}</code></dd></div>
          <div><dt>新构建</dt><dd><code>{snapshot.latestBuildId || '未知'}</code></dd></div>
        </>}
      </dl>

      {snapshot.state === 'downloading' && <section className="update-download" aria-label="更新下载进度">
        <div className="update-download-head"><span>{downloadedMeta || '正在建立下载连接'}</span><span>{progress === null ? '正在获取进度' : `${Math.round(progress)}%`}</span></div>
        <div className="update-progress-track" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
          <span style={{ width: `${progress ?? 0}%` }} />
        </div>
        {speed && <p className="update-download-speed">{speed}/s</p>}
        <p className="update-description">关闭此窗口后，下载仍会继续。</p>
      </section>}

      {snapshot.state === 'downloaded' && <p className="update-description">立即安装会重启 Pi Studio；选择稍后安装，将在下次正常退出应用时安装。</p>}
      {visibleError && <p className="update-error" role="alert">{visibleError}</p>}

      {showRelease && (snapshot.releaseName || snapshot.releaseNotes || published) && <section className="update-notes" aria-label="发行说明">
        <div className="update-notes-head"><h3>发行说明</h3>{published && <span>{published}</span>}</div>
        {snapshot.releaseName && <p className="update-release-name">{snapshot.releaseName}</p>}
        {snapshot.releaseNotes && <div className="update-notes-copy">{snapshot.releaseNotes}</div>}
      </section>}
    </div>

    <footer className="update-footer">
      <button type="button" className="settings-outline" onClick={onClose}>{snapshot.state === 'downloaded' ? '稍后安装' : snapshot.state === 'available' ? '稍后' : '关闭'}</button>
      {snapshot.state === 'downloaded' ? <button type="button" className="settings-save" disabled={pendingAction !== null} onClick={() => void run('install', onInstall)}>
        {pendingAction === 'install' ? '正在重启…' : '立即重启并更新'}
      </button> : snapshot.state === 'available' ? <button type="button" className="settings-save" disabled={pendingAction !== null} onClick={() => void run('download', onDownload)}>
        {pendingAction === 'download' ? '正在开始…' : '下载更新'}
      </button> : !['unsupported', 'downloading', 'checking'].includes(snapshot.state) && <button type="button" className="settings-save" disabled={pendingAction !== null} onClick={() => void run('check', onCheck)}>
        {pendingAction === 'check' ? '正在检查…' : snapshot.state === 'error' ? '重新检查' : '检查更新'}
      </button>}
    </footer>
  </DetailDialog>;
}
