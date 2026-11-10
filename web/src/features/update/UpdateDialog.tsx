import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { errorText } from '../../shared/error-text';
import type { UpdateSnapshot } from '../../types/update-types';
import { normalizeUpdateProgress } from './update-presentation';
import {
  parseReleaseNoteInline,
  parseReleaseNotes,
  shouldFoldReleaseNotes,
  type ReleaseNoteBlock,
} from './update-notes';
import './update-dialog.css';

type UpdateAction = 'check' | 'download' | 'install';

function shortDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

function formatBytes(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function kickerFor(snapshot: UpdateSnapshot): string {
  if (snapshot.state === 'checking') return '正在检查更新';
  if (snapshot.state === 'available') return snapshot.updateKind === 'same-version' ? '发现同版本新构建' : '发现新版本';
  if (snapshot.state === 'downloading') return '正在下载更新';
  if (snapshot.state === 'downloaded') return '已准备好安装';
  if (snapshot.state === 'up-to-date') return '已是最新版本';
  if (snapshot.state === 'error') return '更新未完成';
  if (snapshot.state === 'unsupported') return '当前环境不支持更新';
  return '检查应用更新';
}

function headlineFor(snapshot: UpdateSnapshot): string {
  const showsLatest = ['available', 'downloading', 'downloaded'].includes(snapshot.state);
  if (showsLatest && snapshot.latestVersion) return `v${snapshot.latestVersion}`;
  return snapshot.currentVersion ? `v${snapshot.currentVersion}` : 'Pi Studio';
}

function renderInline(text: string) {
  return parseReleaseNoteInline(text).map((token, index) => {
    if (token.kind === 'strong') return <strong key={index}>{token.text}</strong>;
    if (token.kind === 'code') return <code key={index}>{token.text}</code>;
    return <span key={index}>{token.text}</span>;
  });
}

function ReleaseNoteBlocks({ blocks }: { blocks: ReleaseNoteBlock[] }) {
  return <>{blocks.map((block, index) => {
    if (block.kind === 'heading') return <h4 key={index} className="update-note-heading">{renderInline(block.text)}</h4>;
    if (block.kind === 'list') {
      return <ul key={index} className="update-note-list">
        {block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}
      </ul>;
    }
    return <p key={index} className="update-note-paragraph">{renderInline(block.text)}</p>;
  })}</>;
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
  const [notesExpanded, setNotesExpanded] = useState(false);
  const pendingRef = useRef<UpdateAction | null>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const progress = normalizeUpdateProgress(snapshot.progress);
  const speed = formatBytes(snapshot.bytesPerSecond);
  const transferred = formatBytes(snapshot.transferred);
  const packageSize = formatBytes(snapshot.packageSize);
  const total = formatBytes(snapshot.total);
  const published = shortDate(snapshot.publishedAt);
  const showRelease = ['available', 'downloading', 'downloaded'].includes(snapshot.state);
  const sameVersionBuild = showRelease && snapshot.updateKind === 'same-version';
  const latestVersion = showRelease && snapshot.latestVersion;
  const snapshotError = (snapshot.state === 'error' || snapshot.state === 'unsupported') && snapshot.error;
  const visibleError = actionError || snapshotError;

  // 进度到 100% 之后更新器还要校验整包，这段时间没有流量，需要单独一句话。
  const verifying = snapshot.state === 'downloading' && progress !== null && progress >= 100;
  // 差分下载只传变化的块：总量远小于整包时，说明这是一次增量更新。
  const incremental = typeof snapshot.total === 'number' && typeof snapshot.packageSize === 'number'
    && snapshot.total > 0 && snapshot.total < snapshot.packageSize * 0.9;
  const downloadBadge = !showRelease ? '' : snapshot.state === 'downloading'
    ? (typeof snapshot.packageSize === 'number' ? (incremental ? '增量更新' : '完整更新') : '')
    : snapshot.state === 'available' && packageSize ? `约 ${packageSize}` : '';

  const notes = useMemo(() => parseReleaseNotes(snapshot.releaseNotes), [snapshot.releaseNotes]);
  const folded = useMemo(() => shouldFoldReleaseNotes(notes), [notes]);
  const notesCollapsed = folded && !notesExpanded;

  const meta = showRelease ? [published, downloadBadge].filter(Boolean).join(' · ') : '';
  const subline = sameVersionBuild
    ? `构建 ${snapshot.currentBuildId || '未知'} → ${snapshot.latestBuildId || '未知'}`
    : latestVersion && snapshot.currentVersion ? `当前 v${snapshot.currentVersion}` : '';

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

  return <DetailDialog className="update-dialog" onClose={onClose}>
    <header className="update-header">
      <div className="update-heading">
        <p className="update-kicker" aria-live="polite">{kickerFor(snapshot)}</p>
        <h2 className="update-title">{headlineFor(snapshot)}</h2>
        {subline && <p className="update-subline">{subline}</p>}
        {meta && <p className="update-meta">{meta}</p>}
      </div>
      <button className="icon-button update-close" type="button" aria-label="关闭更新窗口" onClick={onClose}><X /></button>
    </header>

    <div className="update-body">
      {snapshot.state === 'downloading' && <section className={`update-download${verifying ? ' is-verifying' : ''}`} aria-label="更新下载进度">
        <div className="update-download-head">
          <span className="update-download-size">{transferred && total ? `${transferred} / ${total}` : transferred || '正在建立下载连接'}</span>
          <span className="update-download-percent">{progress === null ? '正在获取进度' : `${Math.round(progress)}%`}</span>
        </div>
        <div className="update-progress-track" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
          <span style={{ width: `${progress ?? 0}%` }} />
        </div>
        <div className="update-download-foot">
          <span>{verifying ? '正在校验安装包…' : speed ? `${speed}/s` : ' '}</span>
          <span>关闭此窗口后，下载仍会继续</span>
        </div>
      </section>}

      {snapshot.state === 'downloaded' && <section className="update-ready" aria-label="更新已就绪">
        <span className="update-ready-icon" aria-hidden="true"><Check /></span>
        <div>
          <p className="update-ready-title">下次启动即为 v{snapshot.latestVersion || snapshot.currentVersion}</p>
          <p className="update-description">立即安装会重启 Pi Studio；选择稍后安装，将在下次正常退出应用时安装。</p>
        </div>
      </section>}

      {visibleError && <p className="update-error" role="alert">{visibleError}</p>}

      {showRelease && notes.length > 0 && <section className="update-notes" aria-label="发行说明">
        <div className="update-notes-head">
          <h3>更新内容</h3>
        </div>
        <div className={`update-notes-body${notesCollapsed ? ' is-collapsed' : ''}`}>
          <ReleaseNoteBlocks blocks={notes} />
        </div>
        {folded && <button type="button" className="update-notes-toggle" aria-expanded={notesExpanded} onClick={() => setNotesExpanded((value) => !value)}>
          {notesExpanded ? '收起' : '展开全部'}
          <ChevronDown className={notesExpanded ? 'is-flipped' : undefined} aria-hidden="true" />
        </button>}
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
