import { useCallback, useEffect, lazy, Suspense, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  File,
  GitCompare,
  MessageCircle,
  X,
} from 'lucide-react';
import { DeferredFilePreview } from '../shared/DeferredFilePreview';
import { ActionMenu, type MenuAction } from '../shared/ActionMenu';
import { ScrollableTabList, TabActionsButton } from '../shared/ScrollableTabList';
import { tabCloseActions } from '../shared/tab-close-actions';
import { revealFileLabel } from '../shared/desktop-platform';
import { LoadingState } from '../shared/LoadingState';
import { errorText } from '../shared/error-text';
import { prefersFilePreview } from '../shared/file-preview';
import { ChangesView } from '../features/conversation/ChangesView';
import { DiffView } from '../features/conversation/DiffView';
import { TurnFilePreview } from '../features/conversation/TurnFilePreview';
import { GitFileDiff, GitDiffDefaults } from '../features/git/GitFileDiff';
import { GitRepositoryContext, useGitRepositories } from '../features/git/useWorkspaceRepositories';
import type { ConversationSummary } from '../types/durable-types';
import { workspaceFileTab, type ContentTab, type EditorGroup } from './session-layout';
import { useDocumentFile } from './useDocumentFile';
import type { SourceView } from '../shared/editor-state';
const FileComparison = lazy(() => import('../shared/FileComparison').then(module => ({ default: module.FileComparison })));
import type { SessionWorkbench } from './right-panel/useAppWorkbench';
import {
  documentDrafts,
  type FileTab,
} from './session-file';
import type { TurnDiff, TurnDiffFile } from '../types/chat-types';
import type { Preferences } from '../shared/preferences';
import './styles/session-content.css';

export function SessionContentTabs({ controller, chatTabTitle, sessions = [], onOpenConversation, onInspectConversation, onClose, group = 'left' }: {
  controller: SessionWorkbench; chatTabTitle?: string; sessions?: ConversationSummary[];
  group?: EditorGroup;
  onInspectConversation?: (id: string) => void;
  onOpenConversation?: (id: string) => void;
  onClose: (ids: string[], keepId?: string) => void;
}) {
  const { layout, pin, reorder } = controller;
  const right = group === 'right';
  const tabs = right ? layout.right?.tabs ?? [] : layout.tabs;
  const activeId = right ? layout.right?.active : layout.active;
  const focusableId = activeId === 'chat' && !chatTabTitle ? tabs[0]?.id : activeId;
  const activate = right ? controller.activateRight : controller.activate;
  const [menu, setMenu] = useState<{ tabId?: string; anchor: HTMLElement; point?: { x: number; y: number } }>();
  const menuId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const dropdownOpen = Boolean(menu && menu.anchor === menuButton.current);
  useSyncExternalStore(documentDrafts.subscribe, documentDrafts.revision);
  const drag = useRef('');
  useEffect(() => setMenu(undefined), [controller.layoutOwner, activeId, tabs.length]);
  let actions: MenuAction[] = [];
  if (menu) {
    const tab = dropdownOpen ? undefined : tabs.find(tab => tab.id === menu.tabId);
    if (tab?.kind === 'file') actions = controller.fileActions(tab);
    if (tab?.kind === 'conversation' && onInspectConversation) {
      actions = [{ label: '查看会话详情', run: () => onInspectConversation(tab.sessionId) }];
    }
    actions = [...actions, ...tabCloseActions(tabs, menu.tabId, onClose, chatTabTitle ? 'chat' : undefined)];
  }
  return <div className="session-tab-bar" onContextMenu={event => {
    const slot = (event.target as Element).closest<HTMLElement>('[data-tab-id]');
    if (!slot || !tabs.length) return;
    const anchor = slot.matches('[role="tab"]') ? slot : slot.querySelector<HTMLElement>('[role="tab"]');
    if (!anchor) return;
    event.preventDefault();
    setMenu({ tabId: slot.dataset.tabId, anchor, point: { x: event.clientX, y: event.clientY } });
  }}>
    <ScrollableTabList key={controller.layoutOwner} className="session-content-tabs" activeId={activeId}
      label={right ? '右侧编辑器标签' : controller.shared ? '工作树标签' : '当前会话标签'}
      onKeyDown={(event) => {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]'));
        const button = event.target as HTMLButtonElement;
        const index = buttons.indexOf(button);
        if (index < 0) return;
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          if (!tabs.length) return;
          event.preventDefault();
          setMenu({ tabId: button.closest<HTMLElement>('[data-tab-id]')?.dataset.tabId, anchor: button });
          return;
        }
        const next =
          event.key === 'ArrowRight'
            ? (index + 1) % buttons.length
            : event.key === 'ArrowLeft'
              ? (index + buttons.length - 1) % buttons.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : -1;
        if (next >= 0) {
          event.preventDefault();
          buttons[next].focus();
          buttons[next].click();
        }
      }}
    >
      {chatTabTitle && <button
        type="button"
        role="tab"
        data-tab-id="chat"
        data-current-tab={activeId === 'chat' || undefined}
        aria-selected={layout.active === 'chat'}
        aria-keyshortcuts={tabs.length ? 'Shift+F10' : undefined}
        tabIndex={layout.active === 'chat' ? 0 : -1}
        title={chatTabTitle}
        onClick={() => activate('chat')}
      >
        <MessageCircle />
        <span>{chatTabTitle}</span>
      </button>}
      {tabs.map((tab) => {
        const chat = tab.kind === 'conversation' ? sessions.find(item => item.id === tab.sessionId) : undefined;
        const label = chat?.title || tab.title;
        const draft = documentDrafts.get(JSON.stringify([controller.layoutOwner, tab.id]));
        const dirty = Boolean(draft && draft.base.text !== draft.text);
        return (
          <div
            className="document-tab"
            key={tab.id}
            data-tab-id={tab.id}
            data-current-tab={activeId === tab.id || undefined}
            data-preview={tab.preview || undefined}
            onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
            onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose([tab.id]); } }}
            draggable
            onDragStart={(event) => {
              drag.current = tab.id;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', tab.title);
            }}
            onDragEnd={() => {
              drag.current = '';
            }}
            onDragOver={(event) => {
              if (drag.current) event.preventDefault();
            }}
            onDrop={(event) => {
              if (drag.current) {
                event.preventDefault();
                reorder(drag.current, tab.id, group);
              }
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeId === tab.id}
              aria-keyshortcuts="Shift+F10"
              tabIndex={focusableId === tab.id ? 0 : -1}
              aria-label={label}
              title={tab.kind === 'file' ? tab.path : chat?.running ? label + ' · 运行中' : label}
              onClick={() => tab.kind === 'conversation' ? onOpenConversation?.(tab.sessionId) : activate(tab.id)}
              onDoubleClick={() => pin(tab.id, group)}
            >
              {tab.kind === 'conversation' ? <MessageCircle /> : tab.kind === 'file' ? <File /> : <GitCompare />}
              <span>{label}</span>{dirty && <i className="document-dirty" aria-label="未保存" title="未保存" />}
              {chat?.running && <i className="conversation-tab-running" role="img" aria-label="运行中" />}
            </button>
            <button type="button" className="tab-close" aria-label={'关闭 ' + label} onClick={() => onClose([tab.id])}>
              <X />
            </button>
          </div>
        );
      })}
    </ScrollableTabList>
    {tabs.length + (chatTabTitle ? 1 : 0) > 1 && <TabActionsButton buttonRef={menuButton} expanded={dropdownOpen} menuId={menuId}
      onOpen={anchor => setMenu({ tabId: activeId, anchor })} onClose={() => setMenu(undefined)} />}
    {menu && <ActionMenu id={menuId} className="tab-close-menu" label="标签页操作" anchor={menu.anchor}
      align={dropdownOpen ? 'end' : 'start'} {...(menu.point ?? { placement: 'below' as const })}
      items={actions} onClose={() => setMenu(undefined)} />}
  </div>;
}

function FileDocument({ tab, controller, group }: { tab: FileTab; controller: SessionWorkbench; group: EditorGroup }) {
  const owner = controller.layoutOwner;
  const key = JSON.stringify([owner, tab.id]);
  const { file, error: readError, refresh, save } = useDocumentFile(owner, tab);
  const savedEdit = useSyncExternalStore(documentDrafts.subscribe, () => documentDrafts.get(key));
  const [actionError, setError] = useState('');
  const { cwd, source, sessionId, path } = tab;
  const jump = controller.fileJump(tab.id, group);
  const view: SourceView = { documentId: key, viewId: JSON.stringify([owner, group, tab.id]), scroll: tab.scroll,
    onScroll: top => controller.scroll(tab.id, top, group), initialLine: jump || tab.scroll === undefined ? tab.line : undefined,
    initialColumn: tab.column, jump,
    navigation: source === 'workspace' && !file?.truncated && /\.[cm]?[jt]sx?$/i.test(path) && window.piApi.workspaceCode ? {
      query: (kind, line, column) => window.piApi.workspaceCode({ cwd, path, kind, line, column, drafts: documentDrafts.inWorkspace(owner, cwd) }),
      open: (origin, target, side) => controller.navigateCode(tab, group, origin, target, side), back: controller.goBack,
    } : undefined,
  };
  const actionSource = file?.source ?? source;
  const actionPath = file?.actionPath ?? path;
  const request = useMemo(() => ({ cwd, source: actionSource, sessionId, path: actionPath }), [cwd, actionSource, sessionId, actionPath]);
  const run = useCallback((operation: Promise<unknown>) => {
    void operation.catch((cause) => setError(errorText(cause)));
  }, []);
  const loadApplications = useCallback(async () => {
    const { apps } = await window.piApi.fileActions(request);
    return apps.map(app => ({ id: app.path, label: app.name,
      run: () => run(window.piApi.openWith({ ...request, appPath: app.path })),
    }));
  }, [request, run]);
  const openDefault = () => run(window.piApi.openWith(request));
  return (
    <>
      <DeferredFilePreview
        file={file ?? null}
        loading={!file && !readError}
        onEdit={() => controller.pin(tab.id, group)}
        sourceView={view} currentEdit={() => documentDrafts.get(key)} savedEdit={savedEdit}
        onDraftEdit={(draft) => {
          if (draft) documentDrafts.set(key, draft);
          else documentDrafts.delete(key);
        }}
        initialLine={view.initialLine}
        sourceOnOpen={Boolean(tab.line)}
        fileJump={jump}
        refreshError={readError ? { message: readError, onRetry: refresh } : undefined}
        editable={tab.source === 'workspace' && file?.kind === 'text' && !file.truncated}
        onOpenExternal={openDefault}
        onSave={save}
        onBack={controller.canGoBack ? controller.goBack : undefined}
        onSplit={group === 'left' ? () => controller.openRight(tab) : undefined}
        fileActions={controller.fileActions(tab, group)}
        openWith={{ loadApplications, openDefault, reveal: { label: revealFileLabel(), run: () => run(window.piApi.revealFile(request)) } }}
      />
      {actionError && <p role="alert">{actionError}</p>}
    </>
  );
}
function TurnDocument({
  tab,
  turns,
  controller,
}: {
  tab: Extract<ContentTab, { kind: 'diff' | 'changes' }>;
  turns?: TurnDiff[];
  controller: SessionWorkbench;
}) {
  const [file, setFile] = useState<TurnDiffFile>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [savedTurns, setSavedTurns] = useState<TurnDiff[]>();
  useEffect(() => {
    if (tab.kind !== 'changes' || turns) return;
    let current = true;
    void window.piApi.conversationSnapshot(tab.sessionId).then(snapshot => {
      if (current) setSavedTurns(snapshot?.turnDiffs ?? []);
    }, cause => { if (current) setError(errorText(cause)); });
    return () => { current = false; };
  }, [tab.kind, tab.sessionId, Boolean(turns), retry]);
  const available = turns ?? savedTurns;
  const turn = available?.find(item => item.at === tab.turnAt);
  useEffect(() => {
    let active = true;
    if (tab.kind === 'diff')
      void window.piApi.turnDiffFile({ sessionId: tab.sessionId, at: tab.turnAt, path: tab.path }).then(
        (next) => {
          if (active) {
            setFile(next);
            setError('');
          }
        },
        (cause) => {
          if (active) setError(errorText(cause));
        },
      );
    return () => {
      active = false;
    };
  }, [tab.kind, tab.path, tab.sessionId, tab.turnAt, retry]);
  if (error)
    return (
      <p role="alert">
        {error} <button onClick={() => { setError(''); setRetry(n => n + 1); }}>重试</button>
      </p>
    );
  if (tab.kind === 'changes')
    return turn ? (
      <ChangesView
        sessionId={tab.sessionId}
        initial={turn}
        turns={available ?? [turn]}
        focusPath={tab.path}
        onOpenFile={(path) => void controller.openFile(path, tab.sessionId, 'diff')}
        onOpenDiff={(next, at) => controller.openDiffTab(next, at, tab.sessionId)}
      />
    ) : !available ? <LoadingState variant="panel">正在读取回合变更…</LoadingState> : (
      <p>这次回合变更已不可用。</p>
    );
  if (!file) return <LoadingState variant="panel">正在读取差异…</LoadingState>;
  return prefersFilePreview(file.label, file.binary) ? (
    <TurnFilePreview sessionId={tab.sessionId} at={tab.turnAt} file={file} />
  ) : (
    <DiffView file={file} />
  );
}

export function SessionDocument({
  tab,
  controller,
  turns,
  preferences, group = 'left',
}: {
  group?: EditorGroup;
  tab: Exclude<ContentTab, { kind: 'conversation' }>;
  controller: SessionWorkbench;
  turns?: TurnDiff[];
  preferences: Preferences;
}) {
  const repositories = useGitRepositories();
  const host = useRef<HTMLElement>(null);
  const initialScroll = useRef(tab.scroll || 0);
  const save = controller.scroll;
  useLayoutEffect(() => {
    const root = host.current!;
    let timer: ReturnType<typeof setTimeout>;
    let top: number | undefined;
    function flush() {
      if (top !== undefined) save(tab.id, top, group);
    }
    function scroll(event: Event) {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('.studio-source-editor') || target.scrollHeight <= target.clientHeight) return;
      top = target.scrollTop;
      clearTimeout(timer);
      timer = setTimeout(flush, 160);
    }
    const restore = () => {
      if (!initialScroll.current) return;
      const candidates = [
        root,
        ...root.querySelectorAll<HTMLElement>(
          '.file-preview-document,.file-preview-body,.diff-view-body,.changes-list,textarea',
        ),
      ];
      const scroller = candidates.find(
        (node) =>
          node.clientHeight > 0 &&
          node.scrollHeight > node.clientHeight &&
          ['auto', 'scroll', 'overlay'].includes(getComputedStyle(node).overflowY),
      );
      if (scroller) {
        scroller.scrollTop = initialScroll.current;
        initialScroll.current = 0;
      }
    };
    const observer = new MutationObserver(restore);
    observer.observe(root, { childList: true, subtree: true });
    restore();
    root.addEventListener('scroll', scroll, true);
    window.addEventListener('pagehide', flush);
    return () => {
      observer.disconnect();
      window.removeEventListener('pagehide', flush);
      root.removeEventListener('scroll', scroll, true);
      clearTimeout(timer);
      flush();
    };
  }, [tab.id, group, save]);
  const selected =
    tab.kind === 'git-diff'
      ? repositories.repositories.find((repo) => repo.id === tab.repository)
      : undefined;
  return (
    <main ref={host} className="shell-canvas session-document" aria-label={tab.title} role="tabpanel">
      {tab.kind === 'file' ? (
        <FileDocument tab={tab} controller={controller} group={group} />
      ) : tab.kind === 'comparison' ? (
        <ComparisonDocument tab={tab} owner={controller.layoutOwner} />
      ) : tab.kind === 'git-diff' ? (
        selected ? (
          <GitRepositoryContext.Provider value={{ ...repositories, selected }}>
            <GitDiffDefaults.Provider value={preferences}>
              <GitFileDiff sessionId={tab.sessionId} source={tab.source} />
            </GitDiffDefaults.Provider>
          </GitRepositoryContext.Provider>
        ) : repositories.loading ? (
          <LoadingState variant="panel">正在读取仓库…</LoadingState>
        ) : (
          <p>仓库已不可用。</p>
        )
      ) : (
        <TurnDocument tab={tab} controller={controller} turns={turns} />
      )}
    </main>
  );
}

function ComparisonDocument({ tab, owner }: { tab: Extract<ContentTab, { kind: 'comparison' }>; owner: string }) {
  const before = workspaceFileTab(tab.cwd, tab.original), after = workspaceFileTab(tab.cwd, tab.path);
  const left = useDocumentFile(owner, before), right = useDocumentFile(owner, after);
  const readDraft = (id: string) => documentDrafts.get(JSON.stringify([owner, id]))?.text;
  const original = useSyncExternalStore(documentDrafts.subscribe, () => readDraft(before.id));
  const modified = useSyncExternalStore(documentDrafts.subscribe, () => readDraft(after.id));
  if (left.error || right.error) return <p role="alert">{left.error || right.error} <button onClick={() => { void left.refresh(); void right.refresh(); }}>重试</button></p>;
  if (!left.file || !right.file) return <LoadingState variant="panel">正在读取比较文件…</LoadingState>;
  if ([left.file, right.file].some(file => file.kind !== 'text' || file.truncated)) return <p>逐行比较需要两份完整的文本文件。</p>;
  const beforeText = original ?? left.file.text ?? '', afterText = modified ?? right.file.text ?? '';
  return <><header className="source-compare-title"><span title={tab.original}>{tab.original}</span><span title={tab.path}>{tab.path}</span></header>
    {beforeText === afterText && <p className="source-compare-status" role="status">两份文件内容相同</p>}
    <Suspense fallback={<LoadingState variant="panel">正在计算差异…</LoadingState>}><FileComparison original={beforeText}
      modified={afterText} originalPath={tab.original} modifiedPath={tab.path} /></Suspense></>;
}

export function RightEditorGroup({controller, preferences}: {controller: SessionWorkbench; preferences: Preferences}) {
  const group = controller.layout.right;
  const tab = group?.tabs.find(item => item.id === group.active);
  if (!tab) return null;
  return <section className="session-side-group" aria-label="右侧编辑器组">
    <SessionContentTabs controller={controller} group="right" onClose={(ids, keepId) => controller.closeTabs(ids, 'right', keepId)} />
    <SessionDocument key={controller.layoutOwner + tab.id} group="right" tab={tab} controller={controller} preferences={preferences} />
  </section>;
}
