import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, FileUp, Maximize, Network, PencilRuler } from 'lucide-react';
import {
  CaptureUpdateAction, Excalidraw, MainMenu, TTDDialog, restoreElements, serializeAsJSON,
} from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import type { ExtensionCanvasScene, ExtensionCanvasSnapshot } from '../../types/extension-types';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { errorText } from '../../shared/error-text';
import { CanvasPlayback } from './CanvasPlayback';

const MAX_SCENE_BYTES = 8 * 1024 * 1024;
const UI_OPTIONS = {
  canvasActions: { loadScene: false, export: false, saveToActiveFile: false, toggleTheme: false },
} as const;

function stamp(elements: readonly ExcalidrawElement[], background: string) {
  return JSON.stringify([background, elements.map(({ id, version, versionNonce, isDeleted }) =>
    [id, version, versionNonce, isDeleted])]);
}

function canvasTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function visibleCanvasScene({ scene, playback }: ExtensionCanvasSnapshot): ExtensionCanvasScene {
  return playback ? { ...scene, elements: scene.elements.slice(0, playback.firstElement) } : scene;
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

async function serializeScene(scene: ExtensionCanvasScene): Promise<ExtensionCanvasScene> {
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

function downloadScene(title: string, scene: ExtensionCanvasScene) {
  const json = serializeAsJSON(scene.elements, scene.appState ?? {}, scene.files ?? {}, 'local');
  const uri = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = uri;
  link.download = `${(title || 'Excalidraw').replace(/[<>:"/\\|?*]/g, '-').slice(0, 120)}.excalidraw`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(uri), 1_000);
}

export default function ExcalidrawCanvas({ board, subscriptionId, writable, writes }: {
  board: ExtensionCanvasSnapshot;
  subscriptionId: string;
  writable: boolean;
  writes: Map<string, Promise<void>>;
}) {
  const [initialBoard] = useState(board);
  const [initialScene] = useState(() => visibleCanvasScene(initialBoard));
  const [editorApi, setEditorApi] = useState<ExcalidrawImperativeAPI>();
  const [initialized, setInitialized] = useState(false);
  const api = initialized ? editorApi : undefined;
  const [theme, setTheme] = useState(canvasTheme);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [hasElements, setHasElements] = useState(board.scene.elements.length > 0);
  const [playbackElements, setPlaybackElements] = useState<readonly ExcalidrawElement[]>();
  const fileInput = useRef<HTMLInputElement>(null);
  const editorStamp = useRef('');
  const lastBoard = useRef<ExtensionCanvasSnapshot>();
  const applyingBoard = useRef(false);
  const revision = useRef(board.revision);
  const lastLocalRevision = useRef(-1);
  const queued = useRef<ExtensionCanvasScene>();
  const failedDraft = useRef<ExtensionCanvasScene>();
  const confirmImport = useActionConfirmation();
  const readOnly = !api || !writable || board.drawing || importing;
  const savedToChat = board.revision > 0 && !board.drawing && !saving && !importing && !failedDraft.current;

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(canvasTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!api || lastBoard.current === board) return;
    const previous = lastBoard.current;
    if (previous && !previous.drawing && !board.drawing) {
      if (board.revision <= lastLocalRevision.current || writes.has(subscriptionId)) return;
    }
    lastBoard.current = board;
    revision.current = board.revision;
    let viewBackgroundColor = api.getAppState().viewBackgroundColor;
    if (previous || board !== initialBoard || board.playback) {
      const elements = restoreElements(board.scene.elements, null, { repairBindings: true, refreshDimensions: true });
      const files = Object.values(board.scene.files ?? {});
      const visible = board.playback ? elements.slice(0, board.playback.firstElement) : elements;
      viewBackgroundColor = board.scene.appState?.viewBackgroundColor ?? '#ffffff';
      applyingBoard.current = true;
      try {
        if (files.length) api.addFiles(files);
        api.updateScene({
          elements: visible, appState: { viewBackgroundColor, selectedElementIds: {} },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      } finally {
        applyingBoard.current = false;
      }
      setPlaybackElements(board.playback ? elements : undefined);
      if (board.playback) {
        api.scrollToContent(elements.slice(board.playback.firstElement), { fitToViewport: true, viewportZoomFactor: .78 });
      }
    }
    const elements = api.getSceneElementsIncludingDeleted();
    editorStamp.current = stamp(elements, viewBackgroundColor);
    setHasElements(elements.some(element => !element.isDeleted));
    if (elements.length && !board.playback && (!previous || (board.drawing && previous.drawing))) {
      api.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: .8 });
    }
  }, [api, board, initialBoard, saving, subscriptionId, writes]);

  function queueSave(scene: ExtensionCanvasScene) {
    queued.current = scene;
    if (writes.has(subscriptionId)) return;
    setSaving(true);
    setError('');
    const pending = (async () => {
      while (queued.current) {
        const local = queued.current;
        queued.current = undefined;
        try {
          const saved = await window.piApi.writeExtensionCanvas({
            subscriptionId, revision: revision.current, scene: await serializeScene(local),
          });
          revision.current = saved.revision;
          lastLocalRevision.current = saved.revision;
          failedDraft.current = undefined;
        } catch (reason) {
          failedDraft.current = queued.current ?? local;
          queued.current = undefined;
          setError(errorText(reason));
        }
      }
    })().finally(() => {
      writes.delete(subscriptionId);
      setSaving(false);
    });
    writes.set(subscriptionId, pending);
  }

  function onChange(elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) {
    // The API callback can run before Excalidraw finishes restoring its initial scene.
    if (appState.isLoading || applyingBoard.current) return;
    if (!initialized) {
      setInitialized(true);
      return;
    }
    // Excalidraw can report its last playback frame while switching out of view mode.
    // Wait for the committed snapshot to establish the next editable revision.
    if (!api || !lastBoard.current || lastBoard.current.drawing !== board.drawing
      || readOnly || appState.newElement || appState.pendingImageElementId
      || appState.editingTextElement || appState.resizingElement || appState.selectedElementsAreBeingDragged
      || appState.multiElement) return;
    const nextStamp = stamp(elements, appState.viewBackgroundColor);
    if (nextStamp === editorStamp.current) return;
    editorStamp.current = nextStamp;
    setHasElements(elements.some(element => !element.isDeleted));
    queueSave({ elements: structuredClone(elements), files, appState: { viewBackgroundColor: appState.viewBackgroundColor } });
  }

  async function importScene(file: File) {
    if (!api || readOnly || saving) return;
    const startingRevision = revision.current;
    if (hasElements && !await confirmImport.confirm({
      title: '导入文件并替换画布？',
      description: '导入后，当前聊天的画布会使用所选文件中的图形。',
      confirmLabel: '替换画布',
      kind: 'discard',
    })) return;
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
      const save = window.piApi.writeExtensionCanvas({ subscriptionId, revision: startingRevision, scene });
      const pending = save.then(() => {}, () => {});
      writes.set(subscriptionId, pending);
      try {
        const saved = await save;
        revision.current = saved.revision;
        const restored = restoreElements(saved.scene.elements, null, { repairBindings: true, refreshDimensions: true });
        const viewBackgroundColor = saved.scene.appState?.viewBackgroundColor ?? '#ffffff';
        editorStamp.current = stamp(restored, viewBackgroundColor);
        api.addFiles(Object.values(saved.scene.files ?? {}));
        api.updateScene({ elements: restored, appState: { viewBackgroundColor }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        api.scrollToContent(restored, { fitToViewport: true, viewportZoomFactor: .8 });
        setHasElements(restored.some(element => !element.isDeleted));
        failedDraft.current = undefined;
        lastLocalRevision.current = saved.revision;
      } finally {
        if (writes.get(subscriptionId) === pending) writes.delete(subscriptionId);
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setImporting(false);
    }
  }

  function download() {
    if (!api) return;
    downloadScene(board.title, failedDraft.current ?? {
      elements: api.getSceneElements(),
      files: api.getFiles(),
      appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor },
    });
  }

  return <div className="extension-drawing-board" data-drawing={board.drawing}>
    <div className="extension-canvas-toolbar">
      <div className="extension-canvas-heading">
        {board.title && <strong title={board.title}>{board.title}</strong>}
        <span className="extension-canvas-status" role="status" title={savedToChat
          ? '画布随当前聊天保存在本机。可以从右侧导出可编辑的 .excalidraw 文件。' : undefined}>
          {board.drawing && <i aria-hidden />}
          {board.drawing ? '正在绘制' : saving ? '正在保存' : importing ? '正在导入' : failedDraft.current ? '未保存' : savedToChat ? '已保存到当前聊天' : ''}
        </span>
      </div>
      <div className="extension-canvas-actions">
        <input ref={fileInput} type="file" hidden accept=".excalidraw,application/json"
          onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importScene(file);
          }} />
        <button type="button" className="icon-button" title="导入 Excalidraw 文件" aria-label="导入 Excalidraw 文件"
          disabled={!api || readOnly || saving} onClick={() => fileInput.current?.click()}><FileUp aria-hidden /></button>
        <button type="button" className="icon-button" title="从 Mermaid 导入" aria-label="从 Mermaid 导入"
          disabled={!api || readOnly} onClick={() => api?.updateScene({ appState: { openDialog: { name: 'ttd', tab: 'mermaid' } } })}><Network aria-hidden /></button>
        <button type="button" className="icon-button" title="适应画布" aria-label="适应画布"
          disabled={!api || !hasElements || board.drawing} onClick={() => api?.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: .8 })}><Maximize aria-hidden /></button>
        <button type="button" className="icon-button" title="导出 Excalidraw 文件" aria-label="导出 Excalidraw 文件"
          disabled={!api || (!hasElements && !failedDraft.current) || board.drawing} onClick={download}><Download aria-hidden /></button>
      </div>
    </div>
    {error && <div className="extension-canvas-feedback" role="alert">
      <span>{error}{failedDraft.current && '。可导出未保存的图形。'}</span>
    </div>}
    <div className="extension-canvas-editor" data-theme={theme}>
      <Excalidraw initialData={initialScene} excalidrawAPI={setEditorApi} onChange={onChange} langCode="zh-CN" theme={theme}
        UIOptions={UI_OPTIONS} name={board.title || 'Excalidraw'} viewModeEnabled={readOnly}
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
      {!hasElements && !board.drawing && <div className="extension-canvas-empty" aria-hidden="true">
        <PencilRuler />
        <strong>画布是空的</strong>
        <span>在聊天里描述要画的图，或在这里直接绘制。</span>
      </div>}
    </div>
    {confirmImport.dialog}
  </div>;
}
