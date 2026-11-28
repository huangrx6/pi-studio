import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check, ChevronDown, Download, FileUp, Maximize, Monitor, Moon, Network, Pencil, PencilRuler, Plus, RefreshCw, Sun, Trash2,
} from 'lucide-react';
import {
  CaptureUpdateAction, Excalidraw, MainMenu, TTDDialog, restoreElements, serializeAsJSON,
} from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { CanvasPlayback, type PlaybackTiming } from './CanvasPlayback';
import { applyStudioTheme } from '../../../sdk/extensions/view-theme.mjs';

const PROTOCOL = 'pi-studio:ext-view:v1';
const THEME_KEY = 'pi-studio.excalidraw.theme';
const MAX_SCENE_BYTES = 8 * 1024 * 1024;
const UI_OPTIONS = {
  canvasActions: { loadScene: false, export: false, saveToActiveFile: false, toggleTheme: false },
} as const;

type ThemeMode = 'app' | 'light' | 'dark';
type CanvasScene = { elements: readonly ExcalidrawElement[]; files?: BinaryFiles; appState?: { viewBackgroundColor: string } };
type BoardSummary = { id: string; title: string; revision: number; elementCount: number; updatedAt: number; drawing: boolean };
type CanvasBoard = {
  boardId: string;
  activeBoardId: string;
  boards: BoardSummary[];
  revision: number;
  drawing: boolean;
  title: string;
  scene: CanvasScene;
  playback?: PlaybackTiming;
};

const THEME_MODES: readonly { mode: ThemeMode; label: string; icon: typeof Monitor }[] = [
  { mode: 'app', label: '跟随应用', icon: Monitor },
  { mode: 'light', label: '浅色', icon: Sun },
  { mode: 'dark', label: '深色', icon: Moon },
];

function loadThemePref(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'app';
  } catch {
    return 'app';
  }
}

function stamp(elements: readonly ExcalidrawElement[], background: string) {
  return JSON.stringify([background, elements.map(({ id, version, versionNonce, isDeleted }) =>
    [id, version, versionNonce, isDeleted])]);
}

function preserveLibraryToggle(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key === ' ' && event.target instanceof HTMLInputElement
    && event.target.matches('.sidebar-trigger__label-element > input[type="checkbox"]')) {
    event.stopPropagation();
  }
}

async function rasterizeImage(file: BinaryFileData, id: string): Promise<BinaryFileData> {
  if (typeof file.dataURL !== 'string') throw new Error('画布包含无效的嵌入图片');
  if (!file.dataURL.startsWith('data:image/svg+xml')) return file;
  if (file.dataURL.length > 1_000_000) throw new Error('画布中的矢量图片过大');
  const image = new Image();
  image.src = file.dataURL;
  await image.decode();
  const canvas = document.createElement('canvas');
  const scale = Math.min(4, 1024 / Math.max(1, image.width, image.height));
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法读取画布图片');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { ...file, id: id as BinaryFileData['id'], mimeType: 'image/png', dataURL: canvas.toDataURL() as BinaryFileData['dataURL'] };
}

async function serializeScene(scene: CanvasScene): Promise<CanvasScene> {
  const elements = scene.elements.filter(element => !element.isDeleted);
  const files: BinaryFiles = {};
  for (const element of elements) {
    if (element.type !== 'image' || !element.fileId) continue;
    const id = element.fileId;
    const file = scene.files?.[id];
    if (file && !Object.hasOwn(files, id)) {
      Object.defineProperty(files, id, { value: await rasterizeImage(file, id), enumerable: true });
    }
  }
  return { elements, files, ...(scene.appState ? { appState: scene.appState } : {}) };
}

function downloadScene(title: string, scene: CanvasScene) {
  const json = serializeAsJSON(scene.elements, scene.appState ?? {}, scene.files ?? {}, 'local');
  const uri = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = uri;
  link.download = `${(title || 'Excalidraw').replace(/[<>:"/\\|?*]/g, '-').slice(0, 120)}.excalidraw`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(uri), 1_000);
}

const pendingRpc = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function postHost(message: Record<string, unknown>) {
  window.parent.postMessage({ protocol: PROTOCOL, ...message }, '*');
}

function invokeHost<T = unknown>(method: string, params: unknown): Promise<T> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pendingRpc.set(requestId, { resolve: resolve as (v: unknown) => void, reject });
    postHost({ type: 'view:invoke', requestId, method, params });
  });
}

export function ExcalidrawPluginApp() {
  const [board, setBoard] = useState<CanvasBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [hostError, setHostError] = useState('');
  const [writable, setWritable] = useState(false);
  const [appTheme, setAppTheme] = useState<'light' | 'dark'>('light');
  const [themePref, setThemePref] = useState<ThemeMode>(loadThemePref);
  const [editorApi, setEditorApi] = useState<ExcalidrawImperativeAPI>();
  const [readyApi, setReadyApi] = useState<ExcalidrawImperativeAPI>();
  const api = editorApi && readyApi === editorApi ? editorApi : undefined;

  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [boardBusy, setBoardBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingBoardId, setEditingBoardId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [error, setError] = useState('');
  const [hasElements, setHasElements] = useState(false);
  const [playbackElements, setPlaybackElements] = useState<readonly ExcalidrawElement[]>();
  const fileInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editorStamp = useRef('');
  const lastBoard = useRef<CanvasBoard>();
  const activeBoardId = useRef('');
  const applyingBoard = useRef(false);
  const revision = useRef(0);
  const lastLocalRevision = useRef(new Map<string, number>());
  const savingInFlight = useRef(false);
  const queued = useRef<{ boardId: string; scene: CanvasScene }>();
  const failedDraft = useRef<CanvasScene>();

  const theme = themePref === 'app' ? appTheme : themePref;
  useLayoutEffect(() => {
    document.documentElement.dataset.canvasTheme = themePref;
  }, [themePref]);
  const selectedTheme = THEME_MODES.find(item => item.mode === themePref) ?? THEME_MODES[0];
  const readOnly = !api || !writable || Boolean(board?.drawing) || importing;
  const savedToChat = Boolean(board && board.revision > 0 && !board.drawing && !saving && !importing && !failedDraft.current);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (event.source !== window.parent || msg?.protocol !== PROTOCOL) return;
      if (msg.type === 'host:context') {
        setAppTheme(applyStudioTheme(msg));
        setWritable(msg.invocable === true && Boolean(msg.sessionId));
        return;
      }
      if (msg.type === 'host:snapshot') {
        setLoading(Boolean(msg.loading));
        setHostError(msg.error || '');
        if (msg.invocable !== undefined) setWritable(Boolean(msg.invocable));
        if (msg.data && typeof msg.data === 'object') {
          setBoard(msg.data as CanvasBoard);
        }
        return;
      }
      if (msg.type === 'host:response') {
        const pending = pendingRpc.get(msg.requestId);
        if (!pending) return;
        pendingRpc.delete(msg.requestId);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error || '操作失败'));
      }
    };
    window.addEventListener('message', onMessage);
    postHost({ type: 'view:ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const cycleTheme = useCallback(() => {
    const order: ThemeMode[] = ['app', 'light', 'dark'];
    const next = order[(order.indexOf(themePref) + 1) % order.length];
    setThemePref(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  }, [themePref]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
      setEditingBoardId(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setEditingBoardId(null);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!api || !board || lastBoard.current === board) return;
    const previous = lastBoard.current;
    const boardSwitched = !previous || previous.boardId !== board.boardId;
    if (!boardSwitched && !previous.drawing && !board.drawing) {
      if (board.revision <= (lastLocalRevision.current.get(board.boardId) ?? -1) || savingInFlight.current) return;
    }
    lastBoard.current = board;
    activeBoardId.current = board.boardId;
    revision.current = board.revision;
    if (boardSwitched) {
      queued.current = undefined;
      failedDraft.current = undefined;
      setError('');
    }
    const elements = restoreElements(board.scene.elements, null, { repairBindings: true, refreshDimensions: true });
    const files = Object.values(board.scene.files ?? {});
    const visible = board.playback ? elements.slice(0, board.playback.firstElement) : elements;
    const viewBackgroundColor = board.scene.appState?.viewBackgroundColor ?? '#ffffff';
    applyingBoard.current = true;
    try {
      if (files.length) api.addFiles(files);
      api.updateScene({
        elements: visible,
        appState: { viewBackgroundColor, selectedElementIds: {} },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    } finally {
      applyingBoard.current = false;
    }
    setPlaybackElements(board.playback ? elements : undefined);
    if (board.playback) {
      api.scrollToContent(elements.slice(board.playback.firstElement), { fitToViewport: true, viewportZoomFactor: .78 });
    }
    const currentEls = api.getSceneElementsIncludingDeleted();
    editorStamp.current = stamp(currentEls, viewBackgroundColor);
    setHasElements(currentEls.some(element => !element.isDeleted));
    if (currentEls.length && !board.playback && (boardSwitched || (board.drawing && previous?.drawing))) {
      api.scrollToContent(currentEls, { fitToViewport: true, viewportZoomFactor: .8 });
    }
  }, [api, board]);

  function queueSave(targetBoardId: string, scene: CanvasScene) {
    queued.current = { boardId: targetBoardId, scene };
    if (savingInFlight.current) return;
    savingInFlight.current = true;
    setSaving(true);
    setError('');
    void (async () => {
      try {
        while (queued.current) {
          const { boardId: jobBoardId, scene: local } = queued.current;
          queued.current = undefined;
          if (jobBoardId !== activeBoardId.current) continue;
          try {
            const saved = await invokeHost<CanvasBoard>('save', {
              boardId: jobBoardId,
              revision: revision.current,
              scene: await serializeScene(local),
            });
            if (saved.boardId === activeBoardId.current) {
              revision.current = saved.revision;
            }
            lastLocalRevision.current.set(saved.boardId, saved.revision);
            failedDraft.current = undefined;
          } catch (reason) {
            failedDraft.current = queued.current?.scene ?? local;
            queued.current = undefined;
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        }
      } finally {
        savingInFlight.current = false;
        setSaving(false);
      }
    })();
  }

  function onChange(elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) {
    if (appState.isLoading || applyingBoard.current) return;
    if (editorApi && readyApi !== editorApi) {
      setReadyApi(editorApi);
      return;
    }
    if (!api || !board || !lastBoard.current || lastBoard.current.boardId !== board.boardId
      || lastBoard.current.drawing !== board.drawing || readOnly || appState.newElement
      || appState.pendingImageElementId || appState.editingTextElement || appState.resizingElement
      || appState.selectedElementsAreBeingDragged || appState.multiElement) return;
    const nextStamp = stamp(elements, appState.viewBackgroundColor);
    if (nextStamp === editorStamp.current) return;
    editorStamp.current = nextStamp;
    setHasElements(elements.some(element => !element.isDeleted));
    queueSave(board.boardId, { elements: structuredClone(elements), files, appState: { viewBackgroundColor: appState.viewBackgroundColor } });
  }

  async function importScene(file: File) {
    if (!api || !board || readOnly || saving) return;
    const targetBoardId = board.boardId;
    const startingRevision = revision.current;
    setImporting(true);
    setError('');
    try {
      if (file.size > MAX_SCENE_BYTES) throw new Error('请选择 8 MB 以内的 Excalidraw 文件');
      const data = JSON.parse(await file.text());
      if (data?.type !== 'excalidraw' || !Array.isArray(data.elements)) throw new Error('请选择可编辑的 .excalidraw 文件');
      const scene = await serializeScene({
        elements: data.elements,
        files: data.files,
        appState: typeof data.appState?.viewBackgroundColor === 'string'
          ? { viewBackgroundColor: data.appState.viewBackgroundColor } : undefined,
      });
      savingInFlight.current = true;
      try {
        const saved = await invokeHost<CanvasBoard>('save', { boardId: targetBoardId, revision: startingRevision, scene });
        revision.current = saved.revision;
        lastLocalRevision.current.set(saved.boardId, saved.revision);
        const restored = restoreElements(saved.scene.elements, null, { repairBindings: true, refreshDimensions: true });
        const viewBackgroundColor = saved.scene.appState?.viewBackgroundColor ?? '#ffffff';
        editorStamp.current = stamp(restored, viewBackgroundColor);
        api.addFiles(Object.values(saved.scene.files ?? {}));
        api.updateScene({ elements: restored, appState: { viewBackgroundColor }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        api.scrollToContent(restored, { fitToViewport: true, viewportZoomFactor: .8 });
        setHasElements(restored.some(element => !element.isDeleted));
        failedDraft.current = undefined;
      } finally {
        savingInFlight.current = false;
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
    }
  }

  async function switchBoard(targetId: string) {
    setMenuOpen(false);
    setEditingBoardId(null);
    if (!board || targetId === board.boardId || boardBusy) return;
    setBoardBusy(true);
    setError('');
    try {
      const next = await invokeHost<CanvasBoard>('selectBoard', { boardId: targetId });
      setBoard(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBoardBusy(false);
    }
  }

  async function handleCreateBoard() {
    if (!writable || board?.drawing || boardBusy || importing) return;
    setMenuOpen(false);
    setEditingBoardId(null);
    setBoardBusy(true);
    setError('');
    try {
      const next = await invokeHost<CanvasBoard>('createBoard', { title: '' });
      setBoard(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBoardBusy(false);
    }
  }

  async function handleRenameBoard(targetId: string) {
    if (!writable || boardBusy) return;
    setBoardBusy(true);
    setError('');
    try {
      const next = await invokeHost<CanvasBoard>('renameBoard', { boardId: targetId, title: editingTitle });
      setBoard(next);
      setEditingBoardId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBoardBusy(false);
    }
  }

  async function handleDeleteBoard(targetId: string, onlyOne: boolean) {
    if (!writable || boardBusy) return;
    setBoardBusy(true);
    setError('');
    try {
      const next = await invokeHost<CanvasBoard>('deleteBoard', { boardId: targetId });
      setBoard(next);
      setEditingBoardId(null);
      if (onlyOne) setMenuOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBoardBusy(false);
    }
  }

  function download() {
    if (!api || !board) return;
    downloadScene(board.title, failedDraft.current ?? {
      elements: api.getSceneElements(),
      files: api.getFiles(),
      appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor },
    });
  }

  if (loading && !board) {
    return <div className="ex-loading">正在打开画布…</div>;
  }

  if (!board) {
    return <div className="ex-loading">
      <span>{hostError || '画布暂时无法读取'}</span>
      <button type="button" className="ex-icon-btn" onClick={() => postHost({ type: 'view:retry' })} aria-label="重试">
        <RefreshCw size="calc(var(--icon-sm) + 1px)" />
      </button>
    </div>;
  }

  const initialScene = board.playback
    ? { ...board.scene, elements: board.scene.elements.slice(0, board.playback.firstElement) }
    : board.scene;
  const boardList = board.boards?.length
    ? board.boards
    : [{ id: board.boardId || 'default', title: board.title, revision: board.revision, elementCount: hasElements ? 1 : 0, updatedAt: 0, drawing: board.drawing }];
  const formatBoardTitle = (item: BoardSummary, index: number) => item.title || (index === 0 ? '默认画布' : `画布 ${index + 1}`);
  const activeIndex = Math.max(0, boardList.findIndex(item => item.id === board.boardId));
  const activeBoardLabel = formatBoardTitle(boardList[activeIndex], activeIndex);

  return <div className="ex-board" data-theme={theme} data-drawing={board.drawing}>
    <div className="ex-toolbar">
      <div className="ex-heading">
        <div className="ex-board-picker" ref={menuRef}>
          <button type="button" className="ex-board-btn" title={activeBoardLabel}
            aria-expanded={menuOpen} aria-haspopup="menu" disabled={boardBusy}
            onClick={() => { setMenuOpen(open => !open); setEditingBoardId(null); }}>
            <span className="ex-board-label">{activeBoardLabel}</span>
            {boardList.length > 1 && <span className="ex-board-count">{boardList.length}</span>}
            <ChevronDown size="calc(var(--icon-xs) + 1px)" aria-hidden />
          </button>
          <button type="button" className="ex-icon-btn" title="新建空白画布" aria-label="新建空白画布"
            disabled={!writable || Boolean(board.drawing) || boardBusy || importing}
            onClick={() => void handleCreateBoard()}>
            <Plus size="calc(var(--icon-sm) + 1px)" aria-hidden />
          </button>
          {menuOpen && <div className="ex-board-menu" role="menu">
            <div className="ex-board-list">
              {boardList.map((item, idx) => {
                const isActive = item.id === board.boardId;
                const label = formatBoardTitle(item, idx);
                const editing = editingBoardId === item.id;
                return <div key={item.id} className={`ex-board-item${isActive ? ' is-active' : ''}`} role="menuitem">
                  {editing ? (
                    <input className="ex-board-rename" autoFocus maxLength={120} value={editingTitle}
                      onChange={event => setEditingTitle(event.currentTarget.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void handleRenameBoard(item.id);
                        } else if (event.key === 'Escape') {
                          event.stopPropagation();
                          setEditingBoardId(null);
                        }
                      }}
                      onBlur={() => setEditingBoardId(null)} />
                  ) : (
                    <>
                      <button type="button" className="ex-board-item-main" disabled={boardBusy}
                        onClick={() => void switchBoard(item.id)}>
                        {isActive && <Check size="calc(var(--icon-xs) + 1px)" aria-hidden />}
                        <span className="ex-board-item-title" title={label}>{label}</span>
                        <span className="ex-board-item-meta">
                          {item.drawing ? '绘制中' : item.elementCount > 0 ? `${item.elementCount} 项` : '空白'}
                        </span>
                      </button>
                      {writable && <div className="ex-board-item-actions">
                        <button type="button" className="ex-mini-btn" title="重命名" aria-label={`重命名 ${label}`}
                          disabled={boardBusy || item.drawing}
                          onClick={event => {
                            event.stopPropagation();
                            setEditingBoardId(item.id);
                            setEditingTitle(item.title);
                          }}><Pencil size="var(--icon-xs)" aria-hidden /></button>
                        <button type="button" className="ex-mini-btn"
                          title={boardList.length <= 1 ? '清空当前画布' : '删除画布'}
                          aria-label={boardList.length <= 1 ? '清空当前画布' : `删除 ${label}`}
                          disabled={boardBusy || item.drawing}
                          onClick={event => {
                            event.stopPropagation();
                            void handleDeleteBoard(item.id, boardList.length <= 1);
                          }}><Trash2 size="var(--icon-xs)" aria-hidden /></button>
                      </div>}
                    </>
                  )}
                </div>;
              })}
            </div>
            <button type="button" className="ex-board-create"
              disabled={!writable || Boolean(board.drawing) || boardBusy || importing}
              onClick={() => void handleCreateBoard()}>
              <Plus size="var(--icon-sm)" aria-hidden />
              <span>新建画布</span>
            </button>
          </div>}
        </div>
        <span className="ex-status" role="status">
          {board.drawing && <i aria-hidden />}
          {board.drawing ? '正在绘制' : saving ? '正在保存' : importing ? '正在导入' : failedDraft.current ? '未保存' : savedToChat ? '已保存到当前聊天' : ''}
        </span>
      </div>
      <div className="ex-actions">
        <button type="button" className="ex-icon-btn" aria-label="切换画板外观" title={`画板外观 · ${selectedTheme.label}（点击切换）`}
          onClick={cycleTheme}><selectedTheme.icon size="calc(var(--icon-sm) + 1px)" aria-hidden /></button>
        <input ref={fileInput} type="file" hidden accept=".excalidraw,application/json"
          onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importScene(file);
          }} />
        <button type="button" className="ex-icon-btn" title="导入 Excalidraw 文件" aria-label="导入 Excalidraw 文件"
          disabled={!api || readOnly || saving} onClick={() => fileInput.current?.click()}><FileUp size="calc(var(--icon-sm) + 1px)" aria-hidden /></button>
        <button type="button" className="ex-icon-btn" title="从 Mermaid 导入" aria-label="从 Mermaid 导入"
          disabled={!api || readOnly} onClick={() => api?.updateScene({ appState: { openDialog: { name: 'ttd', tab: 'mermaid' } } })}><Network size="calc(var(--icon-sm) + 1px)" aria-hidden /></button>
        <button type="button" className="ex-icon-btn" title="适应画布" aria-label="适应画布"
          disabled={!api || !hasElements || board.drawing} onClick={() => api?.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: .8 })}><Maximize size="calc(var(--icon-sm) + 1px)" aria-hidden /></button>
        <button type="button" className="ex-icon-btn" title="导出 Excalidraw 文件" aria-label="导出 Excalidraw 文件"
          disabled={!api || (!hasElements && !failedDraft.current) || board.drawing} onClick={download}><Download size="calc(var(--icon-sm) + 1px)" aria-hidden /></button>
      </div>
    </div>
    {(error || hostError) && <div className="ex-feedback" role="alert">
      <span>{error || hostError}{failedDraft.current && '。可导出未保存的图形。'}</span>
    </div>}
    <div className="ex-editor" data-theme={theme} onKeyDownCapture={preserveLibraryToggle} onKeyUpCapture={preserveLibraryToggle}>
      <Excalidraw key={board.boardId || 'default'} initialData={initialScene} excalidrawAPI={setEditorApi} onChange={onChange} langCode="zh-CN" theme={theme}
        UIOptions={UI_OPTIONS} name={activeBoardLabel} viewModeEnabled={readOnly}
        handleKeyboardGlobally={false} aiEnabled={false} validateEmbeddable={false}
        onLinkOpen={(_, event) => event.preventDefault()}>
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          {!readOnly && !saving && hasElements && <MainMenu.DefaultItems.ClearCanvas />}
        </MainMenu>
        <TTDDialog __fallback />
      </Excalidraw>
      {api && board.playback && playbackElements && <CanvasPlayback api={api} elements={playbackElements} timing={board.playback} />}
      {!hasElements && !board.drawing && <div className="ex-empty" aria-hidden="true">
        <PencilRuler />
        <strong>画布是空的</strong>
        <span>在聊天里描述要画的图，或在这里直接绘制。</span>
      </div>}
    </div>
  </div>;
}
