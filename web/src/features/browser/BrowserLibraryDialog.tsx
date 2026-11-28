import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, FolderOpen, Search, Trash2, X } from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { LoadingState } from '../../shared/LoadingState';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { useSettingsToast } from '../../shared/SettingsToast';
import { errorText } from '../../shared/error-text';
import { formatFileSize } from '../../shared/filesize';
import {
  BROWSER_HISTORY_CLEARED,
  BROWSER_HISTORY_UPDATED,
  clearBrowserHistory,
  loadBrowserHistory,
  removeBrowserHistoryEntry,
  type BrowserHistoryEntry,
  type BrowserLibraryView,
} from './browser-history';

type BrowserDownloadRow = Awaited<ReturnType<typeof window.piApi.browserDownloads>>['downloads'][number];

const LIST_PAGE_SIZE = 20;

const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function formatTime(value: number | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateTimeFormat.format(date) : '';
}

function downloadStatusLabel(item: BrowserDownloadRow): string {
  if (item.state === 'progressing') {
    if (item.totalBytes > 0) {
      const pct = Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100));
      return `下载中 ${pct}% · ${formatFileSize(item.receivedBytes)} / ${formatFileSize(item.totalBytes)}`;
    }
    return `下载中 · ${formatFileSize(item.receivedBytes)}`;
  }
  const size = item.totalBytes > 0 ? formatFileSize(item.totalBytes) : item.receivedBytes > 0 ? formatFileSize(item.receivedBytes) : '';
  const stateLabel = item.state === 'completed'
    ? '已完成'
    : item.state === 'cancelled'
      ? '已取消'
      : item.state === 'interrupted'
        ? (item.error || '下载中断')
        : item.state || '未知';
  return [stateLabel, size, formatTime(item.endedAt || item.startedAt)].filter(Boolean).join(' · ');
}

export function BrowserLibraryDialog({
  view,
  onClose,
  onOpenUrl,
}: {
  view: BrowserLibraryView;
  onClose: () => void;
  onOpenUrl?: (url: string) => void;
}) {
  const showToast = useSettingsToast();
  const confirmation = useActionConfirmation();
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(LIST_PAGE_SIZE);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>(() => (view === 'history' ? loadBrowserHistory() : []));
  const [downloads, setDownloads] = useState<BrowserDownloadRow[]>([]);
  const [loading, setLoading] = useState(view === 'downloads');
  const [busy, setBusy] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const loadDownloads = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.piApi.browserDownloads();
      setDownloads(Array.isArray(result?.downloads) ? result.downloads : []);
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
    if (view === 'history') {
      setHistory(loadBrowserHistory());
      const onCleared = () => setHistory([]);
      const onUpdated = () => setHistory(loadBrowserHistory());
      window.addEventListener(BROWSER_HISTORY_CLEARED, onCleared);
      window.addEventListener(BROWSER_HISTORY_UPDATED, onUpdated);
      return () => {
        window.removeEventListener(BROWSER_HISTORY_CLEARED, onCleared);
        window.removeEventListener(BROWSER_HISTORY_UPDATED, onUpdated);
      };
    }
    void loadDownloads();
    return undefined;
  }, [view, loadDownloads]);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredHistory = useMemo(() => {
    if (!normalizedQuery) return history;
    return history.filter(
      (entry) => entry.title.toLowerCase().includes(normalizedQuery)
        || entry.url.toLowerCase().includes(normalizedQuery),
    );
  }, [history, normalizedQuery]);

  const filteredDownloads = useMemo(() => {
    if (!normalizedQuery) return downloads;
    return downloads.filter(
      (item) => item.filename.toLowerCase().includes(normalizedQuery)
        || item.url.toLowerCase().includes(normalizedQuery),
    );
  }, [downloads, normalizedQuery]);

  function handleRemoveHistory(entry: BrowserHistoryEntry) {
    const next = removeBrowserHistoryEntry(history, entry);
    setHistory(next);
    window.dispatchEvent(new Event(BROWSER_HISTORY_UPDATED));
  }

  async function handleClearHistory() {
    if (!history.length || busy) return;
    const accepted = await confirmation.confirm({
      title: '清空浏览历史？',
      description: '将删除工作台浏览器的访问历史记录，不影响 Cookie 与下载文件。',
      confirmLabel: '清空历史',
      tone: 'danger',
    });
    if (!accepted) return;
    setHistory(clearBrowserHistory());
    window.dispatchEvent(new Event(BROWSER_HISTORY_CLEARED));
    showToast('已清空浏览历史');
  }

  async function handleDownloadAction(action: 'open' | 'reveal' | 'cancel' | 'clear', id?: string) {
    if (busy) return;
    setBusy(`${action}:${id || 'all'}`);
    try {
      if (action === 'open' && id) {
        await window.piApi.browserDownloadOpen(id);
      } else if (action === 'reveal' && id) {
        await window.piApi.browserDownloadReveal(id);
      } else if (action === 'cancel' && id) {
        await window.piApi.browserDownloadCancel(id);
        await loadDownloads();
      } else if (action === 'clear') {
        const result = await window.piApi.browserDownloadClear(id);
        if (Array.isArray(result?.downloads)) setDownloads(result.downloads as BrowserDownloadRow[]);
        else await loadDownloads();
      }
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setBusy('');
    }
  }

  async function handleOpenFolder() {
    if (busy) return;
    setBusy('folder');
    try {
      await window.piApi.browserDownloadsFolder();
    } catch (cause) {
      showToast(errorText(cause), 'error');
    } finally {
      setBusy('');
    }
  }

  const totalCount = view === 'history' ? history.length : downloads.length;
  const matchedCount = view === 'history' ? filteredHistory.length : filteredDownloads.length;

  return <>
    <DetailDialog className="browser-library-dialog" onClose={onClose} label={view === 'history' ? '浏览历史' : '下载记录'}>
      {(close) => <>
        <header className="detail-header">
          <div className="detail-heading">
            <div>
              <div className="browser-library-title-row">
                <h2>{view === 'history' ? '浏览历史' : '下载记录'}</h2>
                {totalCount > 0 && <span className="browser-library-count">{totalCount} 条</span>}
              </div>
            </div>
          </div>
          <button type="button" className="icon-button" aria-label="关闭窗口" onClick={close}><X /></button>
        </header>

        <div className="browser-library-toolbar">
          <label className="browser-library-search">
            <Search aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={view === 'history' ? '搜索标题或网址…' : '搜索文件名或链接…'}
              aria-label={view === 'history' ? '搜索浏览历史' : '搜索下载记录'}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(LIST_PAGE_SIZE);
              }}
            />
          </label>
          <div className="browser-library-actions">
            {view === 'downloads' && (
              <button type="button" className="browser-ghost-btn" disabled={Boolean(busy)} onClick={() => void handleOpenFolder()}>
                <FolderOpen aria-hidden="true" />打开目录
              </button>
            )}
            <button
              type="button"
              className="browser-ghost-btn is-danger"
              disabled={Boolean(busy) || totalCount === 0}
              onClick={() => (view === 'history' ? void handleClearHistory() : void handleDownloadAction('clear'))}
            >
              {view === 'history' ? '清空历史' : '清空列表'}
            </button>
          </div>
        </div>

        <div className="detail-body browser-library-body">
          {view === 'downloads' && loading ? (
            <LoadingState variant="section">正在读取下载记录…</LoadingState>
          ) : matchedCount === 0 ? (
            <p className="browser-library-empty">
              {totalCount === 0
                ? (view === 'history' ? '还没有浏览记录。' : '还没有下载记录。')
                : `没有匹配「${query.trim()}」的记录。`}
            </p>
          ) : view === 'history' ? (
            <>
              <ul className="browser-library-list" aria-label="浏览历史列表">
                {filteredHistory.slice(0, visibleCount).map((entry) => (
                  <li key={`${entry.url}:${entry.visitedAt}`} className="browser-library-row">
                    <div className="browser-library-copy">
                      <strong title={entry.title || entry.url}>{entry.title || entry.url}</strong>
                      <div className="browser-library-meta">
                        <code title={entry.url}>{entry.url}</code>
                        {entry.visitedAt > 0 && <span>{formatTime(entry.visitedAt)}</span>}
                      </div>
                    </div>
                    <div className="browser-library-row-actions">
                      {onOpenUrl && (
                        <button
                          type="button"
                          className="settings-text-button"
                          onClick={() => {
                            close();
                            onOpenUrl(entry.url);
                          }}
                        >
                          <ExternalLink aria-hidden="true" />打开
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-button browser-library-delete"
                        aria-label={`删除历史记录 ${entry.title || entry.url}`}
                        title="删除"
                        onClick={() => handleRemoveHistory(entry)}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {visibleCount < filteredHistory.length && (
                <div className="browser-library-more">
                  <button type="button" className="settings-text-button" onClick={() => setVisibleCount((c) => c + LIST_PAGE_SIZE)}>
                    加载更多（剩余 {filteredHistory.length - visibleCount} 条）
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <ul className="browser-library-list" aria-label="下载记录列表">
                {filteredDownloads.slice(0, visibleCount).map((item) => (
                  <li key={item.id} className="browser-library-row">
                    <div className="browser-library-copy">
                      <strong title={item.filename}>{item.filename}</strong>
                      <div className="browser-library-meta">
                        <span>{downloadStatusLabel(item)}{item.risky ? ' · 可执行文件' : ''}</span>
                      </div>
                    </div>
                    <div className="browser-library-row-actions">
                      {item.state === 'progressing' && (
                        <button type="button" className="settings-text-button" disabled={Boolean(busy)} onClick={() => void handleDownloadAction('cancel', item.id)}>取消</button>
                      )}
                      {item.state === 'completed' && <>
                        <button type="button" className="settings-text-button" disabled={Boolean(busy)} onClick={() => void handleDownloadAction('reveal', item.id)}>定位</button>
                        {!item.risky && (
                          <button type="button" className="settings-text-button" disabled={Boolean(busy)} onClick={() => void handleDownloadAction('open', item.id)}>打开</button>
                        )}
                      </>}
                      {item.state !== 'progressing' && (
                        <button
                          type="button"
                          className="icon-button browser-library-delete"
                          aria-label={`移除下载记录 ${item.filename}`}
                          title="移除"
                          disabled={Boolean(busy)}
                          onClick={() => void handleDownloadAction('clear', item.id)}
                        >
                          <Trash2 aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {visibleCount < filteredDownloads.length && (
                <div className="browser-library-more">
                  <button type="button" className="settings-text-button" onClick={() => setVisibleCount((c) => c + LIST_PAGE_SIZE)}>
                    加载更多（剩余 {filteredDownloads.length - visibleCount} 条）
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </>}
    </DetailDialog>
    {confirmation.dialog}
  </>;
}
