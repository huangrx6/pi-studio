import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpCircle,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { errorText } from '../../shared/error-text';
import type { UpdateSnapshot } from '../../types/update-types';
import {
  normalizeUpdateProgress,
  resolveUpdateFlowPhase,
  type UpdateFlowPhase,
} from './update-presentation';
import {
  parseReleaseNoteInline,
  parseReleaseNotes,
  shouldFoldReleaseNotes,
  type ReleaseNoteBlock,
} from './update-notes';
import './styles/update-dialog.css';

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

function markTone(state: UpdateSnapshot['state']): string {
  if (state === 'available' || state === 'downloaded') return 'is-accent';
  if (state === 'downloading' || state === 'checking') return 'is-busy';
  if (state === 'error' || state === 'unsupported') return 'is-warn';
  if (state === 'up-to-date') return 'is-ok';
  return 'is-quiet';
}

function MarkIcon({ state }: { state: UpdateSnapshot['state'] }) {
  if (state === 'downloaded') return <Check aria-hidden="true" />;
  if (state === 'available') return <Sparkles aria-hidden="true" />;
  if (state === 'downloading') return <Download aria-hidden="true" />;
  if (state === 'checking') return <RefreshCw aria-hidden="true" className="is-spinning" />;
  if (state === 'up-to-date') return <ShieldCheck aria-hidden="true" />;
  if (state === 'error' || state === 'unsupported') return <CircleAlert aria-hidden="true" />;
  return <ArrowUpCircle aria-hidden="true" />;
}

function renderInline(text: string) {
  return parseReleaseNoteInline(text).map((token, index) => {
    if (token.kind === 'strong') return <strong key={index}>{token.text}</strong>;
    if (token.kind === 'code') return <code key={index}>{token.text}</code>;
    return <span key={index}>{token.text}</span>;
  });
}


function flowStepClass(phase: UpdateFlowPhase | null, step: 'download' | 'verify' | 'install'): string | undefined {
  if (!phase) return undefined;
  if (step === 'download') {
    if (phase === 'connecting' || phase === 'downloading') return 'is-current';
    return 'is-done';
  }
  if (step === 'verify') {
    if (phase === 'verifying') return 'is-current';
    if (phase === 'ready' || phase === 'installing') return 'is-done';
    return undefined;
  }
  if (phase === 'ready' || phase === 'installing') return 'is-current';
  return undefined;
}

function UpdateFlowSteps({ phase }: { phase: UpdateFlowPhase | null }) {
  if (!phase) return null;
  return <ol className="update-flow" aria-hidden="true">
    <li className={flowStepClass(phase, 'download')}>下载</li>
    <li className={flowStepClass(phase, 'verify')}>校验</li>
    <li className={flowStepClass(phase, 'install')}>安装</li>
  </ol>;
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

  // 下载字节到齐后，更新器还会校验安装包；这段时间没有流量，需要单独展示校验步骤。
  const flowPhase = resolveUpdateFlowPhase(snapshot.state, snapshot, pendingAction);
  const verifying = flowPhase === 'verifying';
  const connecting = flowPhase === 'connecting';
  const showDownloadProgress = snapshot.state === 'downloading';
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

  const phaseLabel = verifying
    ? '校验安装包'
    : connecting
      ? '建立连接'
      : showDownloadProgress
        ? '下载中'
        : '';
  // 校验阶段强制显示满格，避免还停在 99%。
  const barProgress = verifying ? 100 : progress;

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

  return <DetailDialog className={`update-dialog is-${snapshot.state}`} onClose={onClose}>
    <header className="update-header">
      <div className={`update-mark ${markTone(snapshot.state)}`} aria-hidden="true">
        <MarkIcon state={snapshot.state} />
      </div>
      <div className="update-heading">
        <p className="update-kicker" aria-live="polite">{kickerFor(snapshot)}</p>
        <h2 className="update-title">{headlineFor(snapshot)}</h2>
        {subline && <p className="update-subline">{subline}</p>}
        {meta && <p className="update-meta">{meta}</p>}
      </div>
      <button className="icon-button update-close" type="button" aria-label="关闭更新窗口" onClick={onClose}><X /></button>
    </header>

    <div className="update-body">
      {snapshot.state === 'checking' && <section className="update-panel is-busy" aria-live="polite">
        <span className="update-panel-pulse" aria-hidden="true" />
        <div>
          <p className="update-panel-title">正在向更新服务查询</p>
          <p className="update-description">通常只需几秒。可随时关闭此窗口，检查会在后台继续。</p>
        </div>
      </section>}

      {snapshot.state === 'up-to-date' && <section className="update-panel is-ok">
        <div>
          <p className="update-panel-title">当前安装已是最新</p>
          <p className="update-description">
            {snapshot.checkedAt
              ? `最近检查于 ${shortDate(new Date(snapshot.checkedAt).toISOString()) || '刚才'}。有新版本时会在顶栏提醒你。`
              : '有新版本时会在顶栏提醒你，也可随时再检查一次。'}
          </p>
        </div>
      </section>}

      {snapshot.state === 'idle' && <section className="update-panel is-quiet">
        <div>
          <p className="update-panel-title">保持 Pi Studio 处于最新构建</p>
          <p className="update-description">检查不会上传聊天内容。发现新版本后，可先阅读说明再决定是否下载。</p>
        </div>
      </section>}

      {showDownloadProgress && <section className={`update-download${verifying ? ' is-verifying' : ''}${connecting ? ' is-connecting' : ''}`} aria-label="更新下载进度">
        <div className="update-download-head">
          <div className="update-download-copy">
            {phaseLabel && <span className="update-phase-label">{phaseLabel}</span>}
            <span className="update-download-size">{transferred && total ? `${transferred} / ${total}` : transferred || '正在建立下载连接'}</span>
          </div>
          <span className="update-download-percent">{barProgress === null ? '正在获取进度' : `${Math.round(barProgress)}%`}</span>
        </div>
        <div className="update-progress-track" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={barProgress ?? undefined}>
          <span style={{ width: `${barProgress ?? 0}%` }} />
        </div>
        <div className="update-download-foot">
          <span>{verifying ? '正在校验安装包…' : speed ? `${speed}/s` : connecting ? '连接更新源…' : ' '}</span>
          <span>关闭此窗口后，下载仍会继续</span>
        </div>
        <UpdateFlowSteps phase={flowPhase} />
      </section>}

      {snapshot.state === 'downloaded' && <section className="update-ready" aria-label="更新已就绪">
        <UpdateFlowSteps phase={flowPhase} />
        <div className="update-ready-body">
          <span className="update-ready-icon" aria-hidden="true"><Check /></span>
          <div>
            <p className="update-ready-title">
              {pendingAction === 'install'
                ? '正在重启并安装更新…'
                : `下次启动即为 v${snapshot.latestVersion || snapshot.currentVersion}`}
            </p>
            <p className="update-description">
              {pendingAction === 'install'
                ? '安装程序启动后会关闭当前窗口。请稍候，不要强制退出。'
                : '下载与校验已完成。立即安装会重启 Pi Studio；选择稍后安装，将在下次正常退出应用时安装。'}
            </p>
          </div>
        </div>
      </section>}

      {snapshot.state === 'available' && !notes.length && <section className="update-panel is-accent">
        <div>
          <p className="update-panel-title">可以开始下载</p>
          <p className="update-description">下载在后台进行，可继续聊天。完成后顶栏会提示你重启安装。</p>
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
