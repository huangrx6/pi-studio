import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArchiveRestore, LoaderCircle, Search, X } from 'lucide-react';
import type { ConversationSummary } from '../../types/durable-types';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { errorText } from '../../shared/error-text';
import { isComposingKey } from '../../shared/keyboard-navigation';
import { filterArchivedWorkspaces, type ArchivedWorkspace } from './archive-filter';
import './archived-conversations.css';

type ArchiveAction = 'restore' | 'delete';
type Pending = { id: string; action: ArchiveAction };
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
function updatedLabel(value: number) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : '时间未知';
}

export function ArchivedConversationsSettings({ workspaces, onRestore, onDelete, actionsDisabled = false }: {
  workspaces: ArchivedWorkspace[];
  onRestore: (session: ConversationSummary) => Promise<void>;
  onDelete: (session: ConversationSummary) => Promise<void>;
  actionsDisabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const mounted = useRef(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusAfter = useRef<{ id: string; action: ArchiveAction; order: string[] } | null>(null);
  const groups = useMemo(() => filterArchivedWorkspaces(workspaces, query), [workspaces, query]);
  const total = useMemo(() => workspaces.reduce((sum, workspace) => sum + workspace.sessions.filter(session => session.archived).length, 0), [workspaces]);
  const matched = groups.reduce((sum, workspace) => sum + workspace.sessions.length, 0);
  const locked = Boolean(pending) || actionsDisabled;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Rows may disappear only when the parent supplies a refreshed projection.
  // Restore a lost focus without moving a user's search/menu focus elsewhere.
  useLayoutEffect(() => {
    if (locked || !focusAfter.current) return;
    const request = focusAfter.current;
    const frame = requestAnimationFrame(() => {
      if (!mounted.current || focusAfter.current !== request) return;
      focusAfter.current = null;
      if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
      const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-session-id]') || [])];
      const same = rows.find(row => row.dataset.sessionId === request.id);
      const previousIndex = request.order.indexOf(request.id);
      const neighbourIds = [...request.order.slice(previousIndex + 1), ...request.order.slice(0, previousIndex).reverse()];
      const target = same || neighbourIds.map(id => rows.find(row => row.dataset.sessionId === id)).find(Boolean) || rows[0];
      const button = target?.querySelector<HTMLButtonElement>(`button[data-action="${request.action}"]:not(:disabled)`)
        || target?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      (button || searchRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [groups, locked]);

  async function run(session: ConversationSummary, action: ArchiveAction) {
    if (pendingRef.current || actionsDisabled) return;
    const request = { id: session.id, action };
    pendingRef.current = request;
    focusAfter.current = { ...request, order: groups.flatMap(group => group.sessions.map(item => item.id)) };
    setPending(request);
    setErrors(current => { const next = { ...current }; delete next[session.id]; return next; });
    try {
      if (action === 'restore') await onRestore(session);
      else await onDelete(session);
    } catch (cause) {
      if (mounted.current && pendingRef.current === request) setErrors(current => ({ ...current, [session.id]: errorText(cause) }));
    } finally {
      if (pendingRef.current === request) {
        pendingRef.current = null;
        if (mounted.current) setPending(null);
      }
    }
  }

  function clearSearch() {
    setQuery('');
    searchRef.current?.focus();
  }

  return <div className="settings-sections archived-conversations-settings" ref={rootRef}>
    <SettingsPageHeader icon={<ArchiveRestore />} title="归档会话" />
    {total > 0 && <div className="archive-search-row">
        <div className="archive-search" role="search" aria-label="搜索归档会话">
          <Search aria-hidden="true" />
          <input ref={searchRef} type="search" aria-label="搜索归档会话" placeholder="搜索标题、工作区或路径…" value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Escape' || isComposingKey(event.nativeEvent)) return;
              event.preventDefault(); event.stopPropagation(); clearSearch();
            }} />
          {query && matched > 0 && <button type="button" className="icon-button" aria-label="清除搜索" onClick={clearSearch}><X aria-hidden="true" /></button>}
        </div>
        <span className="archive-result-count" role="status" aria-live="polite">{query.trim() ? `${matched} / ${total}` : total} 个归档会话</span>
      </div>
    }
    {groups.length === 0
      ? <div className="archive-settings-empty">
          <p>{total ? '没有匹配的归档会话' : '还没有归档会话'}</p>
          {!total && <span>归档的会话会保留在这里，可随时恢复。</span>}
          {query && <button type="button" className="settings-text-button" onClick={clearSearch}>清除搜索</button>}
        </div>
      : groups.map(workspace => <section className="archive-workspace-section" key={workspace.cwd} aria-label={workspace.name || workspace.cwd || '未指定工作区'}>
          <header className="archive-workspace-heading">
            <h2>{workspace.name || workspace.cwd.split(/[\\/]/).filter(Boolean).at(-1) || '未指定工作区'}</h2>
            {workspace.cwd && <code title={workspace.cwd}>{workspace.cwd}</code>}
          </header>
          <ul className="archive-session-list">
            {workspace.sessions.map(session => {
              const active = pending?.id === session.id;
              const restoring = active && pending.action === 'restore';
              const deleting = active && pending.action === 'delete';
              return <li className="archive-session-card" key={session.id} data-session-id={session.id} aria-busy={active}>
                <div className="archive-session-copy">
                  <h3>{session.title || '未命名会话'}</h3>
                  <div className="archive-session-meta">
                    <span>{updatedLabel(session.updatedAt)}</span>
                    {session.pinned && <span>已置顶</span>}
                  </div>
                </div>
                <div className="archive-session-actions">
                  <button type="button" className="settings-outline archive-restore-button" data-action="restore" disabled={locked} onClick={() => void run(session, 'restore')}>
                    {restoring && <LoaderCircle className="spin" aria-hidden="true" />}{restoring ? '恢复中…' : '恢复会话'}
                  </button>
                  <button type="button" className="settings-outline archive-delete-button" data-action="delete" disabled={locked} onClick={() => void run(session, 'delete')}>
                    {deleting && <LoaderCircle className="spin" aria-hidden="true" />}{deleting ? '处理中…' : '永久删除'}
                  </button>
                </div>
                {errors[session.id] && <p className="archive-session-error" role="alert">{errors[session.id]}</p>}
              </li>;
            })}
          </ul>
        </section>)}
  </div>;
}
