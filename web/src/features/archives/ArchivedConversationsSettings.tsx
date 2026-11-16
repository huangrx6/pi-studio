import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Ellipsis, FolderClosed, ListFilter, Search, Trash2, X } from 'lucide-react';
import { ActionMenu } from '../../shared/ActionMenu';
import { Select } from '../../shared/Select';
import { LoadingIndicator } from '../../shared/LoadingState';
import type { ConversationSummary } from '../../types/durable-types';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import { errorText } from '../../shared/error-text';
import { isComposingKey } from '../../shared/keyboard-navigation';
import { filterArchivedWorkspaces, workspaceLabel, type ArchivedWorkspace, type PinFilter } from './archive-filter';
import './styles/archived-conversations.css';

type ArchiveAction = 'restore' | 'delete';
type Pending = { id: string; action: ArchiveAction | 'delete-group' };
const pinOptions = [
  { value: 'all', label: '全部会话' },
  { value: 'pinned', label: '已置顶' },
  { value: 'unpinned', label: '未置顶' },
];
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
function updatedLabel(value: number) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : '时间未知';
}

export function ArchivedConversationsSettings({ workspaces, onRestore, onDelete, onDeleteGroup, actionsDisabled = false }: {
  workspaces: ArchivedWorkspace[];
  onRestore: (session: ConversationSummary) => Promise<void>;
  onDelete: (session: ConversationSummary) => Promise<void>;
  onDeleteGroup: (cwd: string, label: string, sessionIds: string[]) => Promise<void>;
  actionsDisabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [pins, setPins] = useState<PinFilter>('all');
  const [project, setProject] = useState('all');
  const [menu, setMenu] = useState<{ cwd: string; x: number; y: number; anchor: HTMLButtonElement } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const mounted = useRef(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusAfter = useRef<{ id: string; action: ArchiveAction; order: string[]; opener?: HTMLButtonElement } | null>(null);
  const archives = useMemo(() => filterArchivedWorkspaces(workspaces, ''), [workspaces]);
  const projects = useMemo(() => [{ value: 'all', label: '所有项目' }, ...archives.map(workspace => ({
    value: workspace.cwd, label: workspaceLabel(workspace), description: workspace.cwd,
  }))], [archives]);
  const selectedProject = projects.some(option => option.value === project) ? project : 'all';
  const groups = useMemo(() => filterArchivedWorkspaces(archives, query, pins, selectedProject === 'all' ? undefined : selectedProject),
    [archives, query, pins, selectedProject]);
  const total = archives.reduce((sum, workspace) => sum + workspace.sessions.length, 0);
  const menuGroup = menu && groups.find(group => group.cwd === menu.cwd);
  const filtered = Boolean(query.trim()) || pins !== 'all';
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
      if (request.opener?.isConnected && !request.opener.disabled) {
        request.opener.focus({ preventScroll: true });
        return;
      }
      const byId = new Map(rows.map(row => [row.dataset.sessionId, row]));
      const same = byId.get(request.id);
      const previousIndex = request.order.indexOf(request.id);
      const neighbourIds = [...request.order.slice(previousIndex + 1), ...request.order.slice(0, previousIndex).reverse()];
      const target = same || byId.get(neighbourIds.find(id => byId.has(id))) || rows[0];
      const button = target?.querySelector<HTMLButtonElement>(`button[data-action="${request.action}"]:not(:disabled)`)
        || target?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      (button || searchRef.current || rootRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [groups, locked]);

  async function run(request: Pending, perform: () => Promise<void>, focusId = request.id) {
    if (pendingRef.current || actionsDisabled) return;
    pendingRef.current = request;
    focusAfter.current = {
      id: focusId, action: request.action === 'delete-group' ? 'delete' : request.action,
      opener: request.action === 'delete-group' ? menu?.anchor : undefined,
      order: groups.flatMap(group => group.sessions.map(item => item.id)),
    };
    setPending(request);
    setErrors(current => { const next = { ...current }; delete next[request.id]; return next; });
    try {
      await perform();
    } catch (cause) {
      if (mounted.current && pendingRef.current === request) setErrors(current => ({ ...current, [request.id]: errorText(cause) }));
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

  return <div className="settings-sections archived-conversations-settings" ref={rootRef} tabIndex={-1} aria-label="归档会话">
    <SettingsPageHeader title="归档会话" />
    {total > 0 && <div className="archive-search-row">
      <div className="archive-search" role="search" aria-label="搜索归档会话">
        <Search aria-hidden="true" />
        <input ref={searchRef} type="search" aria-label="搜索归档会话" placeholder="搜索已归档的会话" value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Escape' || isComposingKey(event.nativeEvent)) return;
            event.preventDefault(); event.stopPropagation(); clearSearch();
          }} />
        {query && <button type="button" className="icon-button" aria-label="清除搜索" onClick={clearSearch}><X aria-hidden="true" /></button>}
      </div>
      <Select value={pins} options={pinOptions} label="按置顶状态筛选" leadingIcon={<ListFilter />}
        onChange={value => setPins(value as PinFilter)} />
      <Select value={selectedProject} options={projects} label="按项目筛选" leadingIcon={<FolderClosed />} onChange={setProject} />
      <span className="sr-only" role="status">{matched} 个归档会话</span>
    </div>}
    {groups.length === 0
      ? <div className="archive-settings-empty">
          <p>{total ? '没有匹配的归档会话' : '还没有归档会话'}</p>
          {!total && <span>归档的会话会保留在这里，可随时恢复。</span>}
          {total > 0 && <button type="button" className="settings-text-button" onClick={() => {
            setPins('all'); setProject('all'); clearSearch();
          }}>重置筛选</button>}
        </div>
      : groups.map(workspace => {
          const label = workspaceLabel(workspace);
          return <section className="archive-workspace-section" key={workspace.cwd} aria-label={label}>
            <header className="archive-workspace-heading">
              <FolderClosed aria-hidden="true" />
              <h2 title={workspace.cwd}>{label}</h2>
              <span>{workspace.sessions.length} 个会话</span>
              <button type="button" className="icon-button" aria-label={`${label} 的归档操作`} title="更多操作"
                aria-haspopup="menu" aria-expanded={menu?.cwd === workspace.cwd} disabled={locked}
                onClick={event => {
                  if (menu?.cwd === workspace.cwd) { setMenu(null); return; }
                  const box = event.currentTarget.getBoundingClientRect();
                  setMenu({ cwd: workspace.cwd, x: box.right, y: box.bottom + 4, anchor: event.currentTarget });
                }}>
                {pending?.action === 'delete-group' && pending.id === workspace.cwd ? <LoadingIndicator /> : <Ellipsis />}
              </button>
            </header>
            {errors[workspace.cwd] && <p className="archive-session-error" role="alert">{errors[workspace.cwd]}</p>}
            <ul className="archive-session-list">
              {workspace.sessions.map(session => {
                const active = pending?.id === session.id;
                const restoring = active && pending.action === 'restore';
                const deleting = active && pending.action === 'delete';
                const title = session.title || '未命名会话';
                return <li className="archive-session-card" key={session.id} data-session-id={session.id} aria-busy={active}>
                  <div className="archive-session-copy">
                    <h3 title={title}>{title}</h3>
                    <div className="archive-session-meta">
                      <span>{updatedLabel(session.updatedAt)}</span>
                      {session.pinned && <span>已置顶</span>}
                    </div>
                  </div>
                  <div className="archive-session-actions">
                    <button type="button" className="icon-button archive-delete-button" data-action="delete" disabled={locked}
                      title={`永久删除「${title}」`} aria-label="永久删除"
                      onClick={() => void run({ id: session.id, action: 'delete' }, () => onDelete(session))}>
                      {deleting ? <LoadingIndicator /> : <Trash2 aria-hidden="true" />}
                    </button>
                    <button type="button" className="archive-restore-button" data-action="restore" disabled={locked}
                      onClick={() => void run({ id: session.id, action: 'restore' }, () => onRestore(session))}>
                      {restoring && <LoadingIndicator />}{restoring ? '恢复中…' : '取消归档'}
                    </button>
                  </div>
                  {errors[session.id] && <p className="archive-session-error" role="alert">{errors[session.id]}</p>}
                </li>;
              })}
            </ul>
          </section>;
        })}
    {menu && menuGroup && <ActionMenu x={menu.x} y={menu.y} anchor={menu.anchor} align="end" onClose={() => setMenu(null)} items={[{
      label: filtered ? `删除筛选出的 ${menuGroup.sessions.length} 个会话` : '删除项目中的全部归档会话',
      destructive: true, disabled: locked,
      run: () => void run({ id: menuGroup.cwd, action: 'delete-group' },
        () => onDeleteGroup(menuGroup.cwd, workspaceLabel(menuGroup), menuGroup.sessions.map(item => item.id)), menuGroup.sessions[0].id),
    }]} />}
  </div>;
}
