import { useCallback, useEffect, useRef, useState } from 'react';
import type { TurnDiff, TurnDiffFile } from '../../types/chat-types';
import type {
  PanelFile,
  PanelFileSource,
  PanelTab,
} from '../app-types';
import { destroyTemporary } from '../../features/conversation/temporary-chat-store';
import { errorText } from '../../shared/error-text';
import { createPanelFileCache, panelFileKey } from './panel-file-cache';
import { usePanelWidth } from './usePanelWidth';

type AppWorkbenchDependencies = {
  workspace: string;
  workspaceRef: { current: string };
  sessionId?: string;
  sessionRef: { current: { id: string; cwd: string } | null };
  sidebarCollapsed: boolean;
  setError: (message: string | null) => void;
};

export function useAppWorkbenchController(deps: AppWorkbenchDependencies) {
  const {
    workspace,
    workspaceRef,
    sessionId,
    sessionRef,
    sidebarCollapsed,
    setError,
  } = deps;

  const [filesOpen, setFilesOpen] = useState(false);
  const [treePath, setTreePath] = useState('');
  const [entries, setEntries] = useState<Array<{ name: string; path: string; type: 'file' | 'directory'; size: number }>>([]);
  const [file, setFile] = useState<PanelFile | null>(null);
  const fileCacheRef = useRef(createPanelFileCache<PanelFile>());
  const fileReadRef = useRef(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [panelTabs, setPanelTabsState] = useState<PanelTab[]>([]);
  const panelTabsRef = useRef<PanelTab[]>([]);
  const setPanelTabs = (update: PanelTab[] | ((tabs: PanelTab[]) => PanelTab[])) => {
    const next = typeof update === 'function' ? update(panelTabsRef.current) : update;
    panelTabsRef.current = next;
    setPanelTabsState(next);
  };
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const closeTabMenu = useCallback(() => setTabMenu(null), []);
  const [activePanelTabId, setActivePanelTabIdState] = useState('');
  const activePanelTabIdRef = useRef('');
  const [panelFullscreen, setPanelFullscreen] = useState(false);
  const { panelWidth, panelMaxWidth, resizePanel } = usePanelWidth(sidebarCollapsed);
  const [panelResizing, setPanelResizing] = useState(false);
  const panelDrag = useRef<{ x: number; width: number } | null>(null);
  const [panelEntered, setPanelEntered] = useState(false);
  const panelCloseTimerRef = useRef<number | null>(null);
  const panelOpenFramesRef = useRef<number[]>([]);
  const [panelSplit, setPanelSplit] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [treeBusy, setTreeBusy] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeOwner, setTreeOwner] = useState('');
  const treeRequestRef = useRef(0);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [fileApps, setFileApps] = useState<Array<{ name: string; path: string; icon?: string }>>([]);
  const fileActionsRef = useRef<HTMLDivElement>(null);

  function setActivePanelTabId(id: string) {
    if (activePanelTabIdRef.current !== id) {
      ++fileReadRef.current;
      setFile(null); setFileBusy(false); setFileError(null);
      setFileMenuOpen(false); setFileApps([]);
    }
    activePanelTabIdRef.current = id;
    setActivePanelTabIdState(id);
  }

  /** 加载目录内容；路径为空表示工作区根目录。 */
  async function loadTree(nextPath: string) {
    const cwd = workspaceRef.current;
    if (!cwd) return;
    const request = ++treeRequestRef.current;
    setTreeBusy(true); setTreeError(null); setTreeOwner(cwd);
    setTreePath(nextPath); setEntries([]);
    try {
      const result = await window.piApi.files(cwd, nextPath);
      if (request !== treeRequestRef.current || cwd !== workspaceRef.current) return;
      setTreePath(result.path); setEntries(result.entries);
    } catch (error) {
      if (request === treeRequestRef.current && cwd === workspaceRef.current) setTreeError(errorText(error));
    } finally {
      if (request === treeRequestRef.current && cwd === workspaceRef.current) setTreeBusy(false);
    }
  }

  /** 打开右侧面板，并用两帧 rAF 触发滑入动画。 */
  function openPanel() {
    for (const frame of panelOpenFramesRef.current) cancelAnimationFrame(frame);
    panelOpenFramesRef.current = [];
    if (panelCloseTimerRef.current !== null) {
      window.clearTimeout(panelCloseTimerRef.current);
      panelCloseTimerRef.current = null;
    }
    setPanelEntered(false);
    setFilesOpen(true);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setPanelEntered(true); return; }
    panelOpenFramesRef.current = [requestAnimationFrame(() => {
      panelOpenFramesRef.current = [requestAnimationFrame(() => { panelOpenFramesRef.current = []; setPanelEntered(true); })];
    })];
  }

  /** 关闭面板：先播放退场动画，再真正卸载并复位全屏状态。 */
  function closePanel() {
    if (!filesOpen) return;
    for (const frame of panelOpenFramesRef.current) cancelAnimationFrame(frame);
    panelOpenFramesRef.current = [];
    setPanelEntered(false);
    if (panelCloseTimerRef.current !== null) window.clearTimeout(panelCloseTimerRef.current);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setFilesOpen(false); setPanelFullscreen(false); panelCloseTimerRef.current = null; return;
    }
    panelCloseTimerRef.current = window.setTimeout(() => {
      setFilesOpen(false);
      setPanelFullscreen(false);
      panelCloseTimerRef.current = null;
    }, 300);
  }

  function openTemporaryChat() {
    const id = crypto.randomUUID();
    setPanelTabs(current => [...current, { id, kind: 'temporary', title: '临时聊天' }]);
    setActivePanelTabId(id);
    if (filesOpen) setPanelEntered(true); else openPanel();
  }

  function openComparisonTab() {
    const existing = panelTabsRef.current.find((tab) => tab.kind === 'comparison');
    if (existing) {
      setActivePanelTabId(existing.id);
      if (filesOpen) setPanelEntered(true); else openPanel();
      return;
    }
    const id = 'comparison';
    setPanelTabs((current) => [...current, { id, kind: 'comparison', title: '双跑' }]);
    setActivePanelTabId(id);
    if (filesOpen) setPanelEntered(true); else openPanel();
  }

  function openTerminalTab() {
    const id = `terminal:${crypto.randomUUID()}`;
    setPanelTabs(current => {
      const ordinal = current.filter(tab => tab.kind === 'terminal').length + 1;
      return [...current, {
        id,
        kind: 'terminal',
        cwd: workspaceRef.current || sessionRef.current?.cwd,
        title: ordinal === 1 ? '终端' : `终端 ${ordinal}`,
      }];
    });
    setActivePanelTabId(id);
    if (filesOpen) setPanelEntered(true); else openPanel();
  }

  /**
   * Open (or reuse) the in-app browser panel. A second call with a URL
   * navigates the existing tab instead of stacking duplicates.
   */
  function openBrowserTab(url = '') {
    const existing = panelTabsRef.current.find((tab) => tab.kind === 'browser');
    if (existing) {
      if (url) setPanelTabs((current) => current.map((tab) => tab.id === existing.id ? { ...tab, url } : tab));
      setActivePanelTabId(existing.id);
      if (filesOpen) setPanelEntered(true); else openPanel();
      return;
    }
    const id = `browser:${crypto.randomUUID()}`;
    setPanelTabs((current) => [...current, { id, kind: 'browser', title: '浏览器', url }]);
    setActivePanelTabId(id);
    if (filesOpen) setPanelEntered(true); else openPanel();
  }

  function openFilesTab() {
    if (!panelTabs.some((tab) => tab.kind === 'files')) {
      setPanelTabs((current) => [...current, { id: 'files', kind: 'files', title: '文件' }]);
    }
    setActivePanelTabId('files');
    setFile(null);
  }

  function openServicesTab() {
    if (!panelTabs.some((tab) => tab.kind === 'services')) {
      setPanelTabs((current) => [...current, { id: 'services', kind: 'services', title: '运行服务' }]);
    }
    setActivePanelTabId('services');
    if (filesOpen) setPanelEntered(true); else openPanel();
  }

  /** 读取文件并按路径缓存，重复打开时直接命中缓存。 */
  /**
   * 工作区文件统一走结构化预览：文本、Markdown、JSON、CSV、图片、音视频、PDF、HTML
   * 都由共享预览组件按类型渲染，工作台的“文件”标签不再只显示纯文本。
   */
  async function loadWorkspacePreview(root: string, target: string): Promise<PanelFile> {
    try {
      const preview = await window.piApi.filePreview(root, target);
      const path = preview.path || target;
      return {
        path,
        size: preview.size,
        binary: preview.kind === 'binary',
        text: preview.text || '',
        preview: { ...preview, path },
      };
    } catch (error) {
      // 预览服务拒绝（越界、无权限）时保留原有错误提示，不退化成"空文件"。
      throw error;
    }
  }

  /**
   * 会话变更文件走受控读取（只允许本轮改过的路径）。不在变更记录里的文件
   * 依次回退：工作区内走普通预览，其它位置交给主进程统一解析——模型给出的
   * `~/…`、相对路径、工作区外绝对路径都能打开，凭据类路径由主进程拒绝。
   */
  async function loadDiffPreview(tab: PanelTab): Promise<PanelFile> {
    const target = tab.path!;
    const cwd = tab.cwd || workspaceRef.current || sessionRef.current?.cwd;
    try {
      return await window.piApi.turnDiffAbsoluteFile({ sessionId: tab.sessionId!, path: target });
    } catch (error) {
      if (cwd && target.startsWith(`${cwd}/`)) {
        try {
          return await loadWorkspacePreview(cwd, target.slice(cwd.length + 1));
        } catch {
          // 工作区预览也拒绝时，继续走统一解析（例如符号链接指向工作区外）。
        }
      }
      return loadExternalPreview(target, cwd, tab.sessionId);
    }
  }

  /** 任意文件引用：`~`、相对路径、工作区外绝对路径都由主进程解析。 */
  async function loadExternalPreview(target: string, cwd?: string, sessionId?: string): Promise<PanelFile> {
    const preview = await window.piApi.filePreviewAbsolute({ path: target, cwd, sessionId });
    const path = preview.path || target;
    return {
      path,
      size: preview.size,
      binary: preview.kind === 'binary',
      text: preview.text || '',
      preview: { ...preview, path },
    };
  }

  async function loadFileToTab(tab: PanelTab): Promise<boolean> {
    if (!tab.path) return false;
    const source = tab.source || (tab.path.startsWith('/') ? 'diff' : tab.path.startsWith('~') ? 'external' : 'workspace');
    const identity = { path: tab.path, source, cwd: tab.cwd, sessionId: tab.sessionId };
    if (source === 'workspace' && !tab.cwd) return false;
    if (source === 'diff' && !tab.sessionId) {
      setFileError('文件变更需要所属会话才能打开');
      return false;
    }
    const key = panelFileKey(identity);
    const cache = fileCacheRef.current;
    const request = ++fileReadRef.current;
    const token = cache.begin(key);
    const current = () => request === fileReadRef.current && activePanelTabIdRef.current === tab.id;
    setFileBusy(true); setFileError(null);
    try {
      const content: PanelFile = source === 'attachment'
        ? await window.piApi.attachmentFile({ path: tab.path })
        : source === 'diff'
          ? await loadDiffPreview(tab)
          : source === 'external'
            ? await loadExternalPreview(tab.path, tab.cwd, tab.sessionId)
            : await loadWorkspacePreview(tab.cwd!, tab.path);
      // A closed/reopened tab has a different read token. Never revive its data.
      if (!panelTabsRef.current.some(item => item.id === tab.id) || !cache.put(key, token, content)) return true;
      if (current()) setFile(content);
      return true;
    } catch (error) {
      if (current() && cache.current(key, token)) setFileError(errorText(error));
      return false;
    } finally {
      cache.finish(key, token);
      if (current()) setFileBusy(false);
    }
  }

  /** Switching retains reloadable content only in a bounded cache. */
  function activatePanelTab(tab: PanelTab) {
    setActivePanelTabId(tab.id);
    if (tab.kind === 'file' && tab.path) {
      const source = tab.source || (tab.path.startsWith('/') ? 'diff' : tab.path.startsWith('~') ? 'external' : 'workspace');
      const cached = fileCacheRef.current.get(panelFileKey({ path: tab.path, source, cwd: tab.cwd, sessionId: tab.sessionId }));
      setFile(cached ?? null);
      if (!cached) void loadFileToTab(tab);
    } else setFile(null);
  }

  /** A workspace file keeps its original root even after switching conversations. */
  async function openFile(
    target: string,
    accessSessionId = sessionRef.current?.id,
    source: PanelFileSource = target.startsWith('/') ? 'diff' : target.startsWith('~') || target.startsWith('file://') ? 'external' : 'workspace',
  ): Promise<boolean> {
    const cwd = workspaceRef.current || sessionRef.current?.cwd;
    if (source === 'workspace' && !cwd) return false;
    const identity = { path: target, source, cwd: source === 'workspace' || source === 'external' ? cwd : undefined, sessionId: source === 'workspace' ? undefined : accessSessionId };
    const key = panelFileKey(identity);
    const id = `file:${key}`;
    const tab: PanelTab = { id, kind: 'file', title: target.split('/').pop() || target, tooltip: source === 'workspace' ? `${cwd}/${target}` : target, ...identity };
    setPanelTabs(current => current.some(item => item.id === id) ? current : [...current, tab]);
    setActivePanelTabId(id);
    const cached = fileCacheRef.current.get(key);
    setFile(cached ?? null);
    if (filesOpen) setPanelEntered(true); else openPanel();
    if (cached) return true;
    return loadFileToTab(tab);
  }

  function disposePanelTab(tab: PanelTab) {
    if (tab.kind === 'file' && tab.path) {
      fileCacheRef.current.drop(panelFileKey({ path: tab.path, source: tab.source || (tab.path.startsWith('/') ? 'diff' : 'workspace'), cwd: tab.cwd, sessionId: tab.sessionId }));
    }
    if (tab.kind === 'temporary') destroyTemporary(tab.id);
    if (tab.kind === 'terminal') void window.piApi.terminalClose(tab.id).catch(() => {});
  }

  /** 关闭标签；最后一个标签关闭后直接收起工作台。 */
  function closePanelTab(id: string) {
    const current = panelTabsRef.current;
    const index = current.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    disposePanelTab(current[index]);
    const next = current.filter((tab) => tab.id !== id);
    setPanelTabs(next);
    if (next.length === 0) {
      setActivePanelTabId('');
      setFile(null);
      setPanelSplit(false);
      if (typeof closePanel === 'function') closePanel();
      return;
    }
    if (activePanelTabIdRef.current === id) {
      const target = next[Math.min(index, next.length - 1)];
      activatePanelTab(target);
    }
  }

  function reorderPanelTabs(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    setPanelTabs((current) => {
      const order = [...current];
      const from = order.findIndex((tab) => tab.id === sourceId);
      const to = order.findIndex((tab) => tab.id === targetId);
      if (from < 0 || to < 0) return current;
      order.splice(to, 0, ...order.splice(from, 1));
      return order;
    });
  }

  /** 打开文件 diff 标签页；已存在时直接激活。 */
  function openDiffTab(file: TurnDiffFile, at: number, ownerSessionId = sessionId) {
    const id = `diff:${ownerSessionId}:${at}:${file.path}`;
    setPanelTabs((current) => current.some((tab) => tab.id === id) ? current : [...current, { id, kind: 'diff', title: file.label.split('/').pop() || file.label, path: file.path, diff: file }]);
    setActivePanelTabId(id);
    if (filesOpen) setPanelEntered(true);
    else openPanel();
  }

  function openChangesTab(file: TurnDiffFile | undefined, turn: TurnDiff, sessions: { id: string; turnDiffs?: TurnDiff[] }) {
    const id = `changes:${sessions.id}`;
    const turns = [...(sessions.turnDiffs ?? []).filter(item => item.at !== turn.at), turn];
    const tab: PanelTab = { id, kind: 'changes', title: '变更', review: { sessionId: sessions.id, initial: turn, turns, focusPath: file?.path } };
    setPanelTabs(current => current.some(item => item.id === id) ? current.map(item => item.id === id ? tab : item) : [...current, tab]);
    setActivePanelTabId(id);
    if (filesOpen) setPanelEntered(true); else openPanel();
  }

  function closePanelTabs(id: string, scope: 'left' | 'right' | 'others' | 'all') {
    const current = panelTabsRef.current;
    const index = current.findIndex(tab => tab.id === id);
    if (index < 0) return;
    const next = current.filter((tab, i) => scope === 'left' ? i >= index : scope === 'right' ? i <= index : scope === 'others' ? tab.id === id : false);
    for (const tab of current) if (!next.some(item => item.id === tab.id)) disposePanelTab(tab);
    setPanelTabs(next);
    if (!next.length) {
      setActivePanelTabId('');
      setFile(null);
      setPanelSplit(false);
      if (typeof closePanel === 'function') closePanel();
    }
    else if (!next.some(tab => tab.id === activePanelTabIdRef.current)) activatePanelTab(next.find(tab => tab.id === id) ?? next[0]);
  }

  function currentFileRequest(appPath?: string) {
    const activePanelTab = panelTabs.find((tab) => tab.id === activePanelTabId) ?? panelTabs[0];
    if (!file || !activePanelTab || activePanelTab.kind !== 'file') return null;
    const source = activePanelTab.source || (file.path.startsWith('/') ? 'diff' : 'workspace');
    if (source === 'workspace' && !activePanelTab.cwd) return null;
    return {
      cwd: activePanelTab.cwd || '',
      path: file.path,
      source,
      sessionId: activePanelTab.sessionId,
      ...(appPath ? { appPath } : {}),
    };
  }

  async function showFileActions() {
    const request = currentFileRequest();
    if (!request) return;
    if (fileMenuOpen) { setFileMenuOpen(false); return; }
    setFileMenuOpen(true);
    setFileApps([]);
    const owner = activePanelTabIdRef.current;
    const revision = fileReadRef.current;
    try {
      const result = await window.piApi.fileActions(request);
      if (owner === activePanelTabIdRef.current && revision === fileReadRef.current) setFileApps(result.apps);
    } catch (error) {
      if (owner === activePanelTabIdRef.current && revision === fileReadRef.current) setFileError(errorText(error));
    }
  }

  async function openFileWith(appPath?: string) {
    const request = currentFileRequest(appPath);
    if (!request) return;
    setFileMenuOpen(false);
    try { await window.piApi.openWith(request); }
    catch (error) { setError(errorText(error)); }
  }

  async function revealCurrentFile() {
    const request = currentFileRequest();
    if (!request) return;
    setFileMenuOpen(false);
    try { await window.piApi.revealFile(request); }
    catch (error) { setError(errorText(error)); }
  }

  const activePanelTab = panelTabs.find((tab) => tab.id === activePanelTabId) ?? panelTabs[0];
  const treeVisible = filesOpen && (activePanelTabId === 'files' || panelSplit);

  useEffect(() => {
    if (treeVisible && workspace) void loadTree('');
    return () => { ++treeRequestRef.current; };
  }, [treeVisible, workspace]);

  useEffect(() => () => {
    ++fileReadRef.current;
    ++treeRequestRef.current;
    fileCacheRef.current.clear();
    if (panelCloseTimerRef.current !== null) window.clearTimeout(panelCloseTimerRef.current);
    for (const frame of panelOpenFramesRef.current) cancelAnimationFrame(frame);
  }, []);

  return {
    filesOpen,
    setFilesOpen,
    treePath,
    setTreePath,
    entries,
    setEntries,
    file,
    setFile,
    fileCacheRef,
    fileReadRef,
    fileError,
    setFileError,
    panelTabs,
    panelTabsRef,
    setPanelTabs,
    tabMenu,
    setTabMenu,
    closeTabMenu,
    activePanelTabId,
    activePanelTabIdRef,
    setActivePanelTabId,
    panelFullscreen,
    setPanelFullscreen,
    panelWidth,
    panelMaxWidth,
    resizePanel,
    panelResizing,
    setPanelResizing,
    panelDrag,
    panelEntered,
    setPanelEntered,
    panelCloseTimerRef,
    panelOpenFramesRef,
    panelSplit,
    setPanelSplit,
    activePanelTab,
    fileBusy,
    setFileBusy,
    treeBusy,
    setTreeBusy,
    treeError,
    setTreeError,
    treeOwner,
    setTreeOwner,
    treeRequestRef,
    fileMenuOpen,
    setFileMenuOpen,
    fileApps,
    setFileApps,
    fileActionsRef,
    loadTree,
    openPanel,
    closePanel,
    openTemporaryChat,
    openComparisonTab,
    openTerminalTab,
    openBrowserTab,
    openFilesTab,
    openServicesTab,
    loadWorkspacePreview,
    loadFileToTab,
    activatePanelTab,
    openFile,
    disposePanelTab,
    closePanelTab,
    reorderPanelTabs,
    openDiffTab,
    openChangesTab,
    closePanelTabs,
    currentFileRequest,
    showFileActions,
    openFileWith,
    revealCurrentFile,
  };
}
