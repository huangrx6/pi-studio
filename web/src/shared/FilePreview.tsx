import { Accordion } from './Accordion';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  Search,
  X,
} from 'lucide-react';
import { LoadingIndicator, LoadingState } from './LoadingState';
import {
  parseDelimitedPreview,
  prettyJson,
  previewExtension,
  previewFormatForFile,
  formatByteSample,
  previewTypeLabel,
  splitPreviewPath,
} from './file-preview.ts';
import type { FilePreviewResult } from '../types/file-preview-types';
import { Markdown } from './Markdown';
import { ArchivePreview } from './ArchivePreview';
import { formatFileSize } from './filesize';
import { FileFormatIcon, FileKindIcon, type FilePreviewFormat } from './FileKindIcon';
import type { MenuAction } from './ActionMenu';
import { FilePreviewMenu, type FileOpenWith } from './FilePreviewMenu';
import './styles/file-preview.css';

import { editorView, type SourceView } from './editor-state';
const SourceEditor = lazy(() => import('./SourceEditor').then(module => ({ default: module.SourceEditor })));

type PreviewMode = 'preview' | 'source';

export type FilePreviewProps = {
  file: FilePreviewResult | null;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  onOpenExternal?: (file: FilePreviewResult) => void;
  editable?: boolean;
  initialLine?: number;
  fileJump?: number;
  sourceView?: SourceView;
  currentEdit?: () => FilePreviewProps['savedEdit'];
  sourceOnOpen?: boolean;
  onEdit?: () => void;
  savedEdit?: {base:FilePreviewResult;text:string};
  onDraftEdit?: (draft?:{base:FilePreviewResult;text:string})=>void;
  onSave?: (text: string, expectedText: string) => Promise<void>;
  refreshError?: { message: string; onRetry: () => void };
  onBack?: () => void;
  onSplit?: () => void;
  fileActions?: MenuAction[];
  openWith?: FileOpenWith;
};

function TablePreview({
  text,
  delimiter,
}: {
  text: string;
  delimiter: string;
}) {
  const table = useMemo(
    () => parseDelimitedPreview(text, delimiter),
    [delimiter, text],
  );
  const headers: string[] = table.headers;
  const rows: string[][] = table.rows;
  if (!headers.length) {
    return <div className="file-preview-empty-inline"><FileFormatIcon format="csv" /><strong>表格没有可显示的内容</strong></div>;
  }
  return <div className="file-preview-table-wrap">
    {table.clippedColumns && <div className="file-preview-inline-note">仅显示前 24 列。</div>}
    <table aria-label="分隔文本预览">
      <thead><tr>{headers.map((header: string, index: number) => <th key={`${index}:${header}`}>{header || '—'}</th>)}</tr></thead>
      <tbody>
        {rows.map((row: string[], rowIndex: number) => <tr key={rowIndex}>
          {headers.map((_header: string, columnIndex: number) => <td key={columnIndex}>{row[columnIndex] ?? ''}</td>)}
        </tr>)}
      </tbody>
    </table>
    {table.clippedRows && <div className="file-preview-inline-note">共 {table.totalRows} 行，仅显示前 300 行。</div>}
  </div>;
}

function MediaPreview({
  file,
  format,
}: {
  file: FilePreviewResult;
  format: 'image' | 'audio' | 'video';
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [file.dataUrl]);

  if (failed) {
    return <div className="file-preview-empty-inline">
      <AlertTriangle />
      <strong>这个文件无法在 Studio 中显示</strong>
      <span>{file.unavailableReason || '文件可能已损坏，或当前系统不支持该编码。'}</span>
    </div>;
  }

  if (!file.dataUrl) {
    return <div className="file-preview-empty-inline">
      <FileFormatIcon format={format} />
      <strong>没有可预览的内容</strong>
    </div>;
  }

  if (format === 'image') {
    return <div className="file-preview-media">
      <img src={file.dataUrl} alt={file.name} onError={() => setFailed(true)} />
    </div>;
  }
  if (format === 'audio') {
    return <div className="file-preview-media is-compact">
      <span className="file-preview-media-mark"><FileFormatIcon format="audio" /></span>
      <div><strong>{file.name}</strong><span>{file.mimeType}</span></div>
      <audio controls src={file.dataUrl} onError={() => setFailed(true)}>当前环境不支持音频播放。</audio>
    </div>;
  }
  return <div className="file-preview-media">
    <video controls src={file.dataUrl} onError={() => setFailed(true)}>当前环境不支持视频播放。</video>
  </div>;
}

function PreviewBody({
  file,
  format,
  mode,
  onOpenExternal,
  text,
  source,
}: {
  file: FilePreviewResult;
  format: FilePreviewFormat;
  mode: PreviewMode;
  onOpenExternal?: (file: FilePreviewResult) => void;
  text: string;
  source: (text: string) => ReactNode;
}) {
  const json = useMemo(() => format === 'json' && mode === 'preview' ? prettyJson(text) : null, [format, text, mode]);

  if (file.kind === 'archive' && file.archive) return <ArchivePreview data={file.archive} />;
  if (file.kind === 'binary' || format === 'unsupported') {
    return <div className="file-preview-unsupported">
      <FileKindIcon path={file.path} mime={file.mimeType} />
      <strong>{previewTypeLabel(file.path)} 暂不支持内嵌预览</strong>
      {file.unavailableReason && <p>{file.unavailableReason}</p>}
      {file.byteSample && <Accordion className="file-preview-bytes" summary={<>查看前 {file.byteSample.length / 2} 字节</>} compact>
        <pre>{formatByteSample(file.byteSample)}</pre></Accordion>}
      {onOpenExternal && <button type="button" className="settings-outline" aria-label="用系统应用打开文件" onClick={() => onOpenExternal(file)}>
        <ExternalLink />用系统应用打开
      </button>}
    </div>;
  }

  if (format === 'image' || format === 'audio' || format === 'video') {
    return <MediaPreview file={file} format={format} />;
  }

  if (mode === 'source' && file.kind === 'text') return source(text);

  if (format === 'markdown') {
    return <div className="file-preview-document">
      <article className="file-preview-markdown"><Markdown>{text}</Markdown></article>
    </div>;
  }

  if (format === 'pdf') {
    // Chromium 自带 PDF 阅读器：data URL 在 iframe 里就能翻页、缩放。
    return file.dataUrl
      ? <div className="file-preview-document is-frame">
        <iframe className="file-preview-frame" src={file.dataUrl} title={`${file.name} PDF 预览`} />
      </div>
      : <div className="file-preview-empty-inline"><FileText /><strong>没有可预览的内容</strong></div>;
  }

  if (format === 'html') {
    // 空 sandbox 白名单：脚本、表单、同源读取全部禁用，只保留静态渲染。
    return <div className="file-preview-document is-frame">
      <iframe className="file-preview-frame" sandbox="" srcDoc={text} title={`${file.name} HTML 预览`} />
    </div>;
  }

  if (format === 'csv') {
    return <div className="file-preview-document is-table">
      <TablePreview text={text} delimiter={previewExtension(file.path) === 'tsv' ? '\t' : ','} />
    </div>;
  }

  if (format === 'json' && json) {
    return <div className="file-preview-code-stack">
      {!json.ok && <div className="file-preview-inline-note is-warning"><AlertTriangle />JSON 格式有误，已按原文显示：{json.error}</div>}
      {source(json.text)}
    </div>;
  }

  return source(text);
}

/**
 * Shared file preview surface with optional workspace editing.
 *
 * The component never reads paths or executes file-provided markup. It renders
 * only a classified JSON-safe payload and uses a single toolbar/state model for
 * every supported format.
 */
export function FilePreview(props: FilePreviewProps) {
  return <FilePreviewContent key={props.sourceView?.viewId ?? props.file?.path} {...props} />;
}

function FilePreviewContent({
  file: latestFile,
  loading = false,
  emptyTitle = '选择一个文件',
  emptyDescription = '',
  onOpenExternal,
  editable = false, initialLine, fileJump, sourceOnOpen, sourceView, currentEdit, onEdit, savedEdit, onDraftEdit,
  onSave,
  refreshError,
  onBack, onSplit, fileActions = [], openWith,
}: FilePreviewProps) {
  const remembered = sourceView && editorView(sourceView.viewId);
  const [mode, setModeState] = useState<PreviewMode>(remembered?.mode ?? (sourceOnOpen ? 'source' : 'preview'));
  const [copyNotice, setCopyNotice] = useState<{ message: string }>();
  const [localDraft, setLocalDraft] = useState<FilePreviewProps['savedEdit']>();
  const [editHere, setEditHere] = useState(remembered?.editing ?? false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showLineNumbers, setShowLineNumbers] = useState(remembered?.lineNumbers ?? true);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const paneRef = useRef<HTMLDivElement>(null);
  const record = onDraftEdit ? savedEdit : localDraft;
  const editBase = record?.base;
  const file = editBase ?? latestFile;
  const editing = editHere && Boolean(record);
  const draft = record?.text ?? file?.text ?? '';
  const changedOnDisk = editBase && latestFile && (latestFile.kind !== editBase.kind ||
    latestFile.truncated !== editBase.truncated || latestFile.changeKey !== editBase.changeKey || latestFile.text !== editBase.text);
  const format = file ? previewFormatForFile(file.path, file.mimeType, file.kind) as FilePreviewFormat : 'text';
  const toggleable = ['markdown', 'csv', 'html', 'json'].includes(format);
  const activeMode = toggleable ? mode : file?.kind === 'text' ? 'source' : 'preview';
  function setMode(next: PreviewMode) { if (remembered) remembered.mode = next; setModeState(next); }
  function changeDraft(next?: FilePreviewProps['savedEdit']) { if (onDraftEdit) onDraftEdit(next); else setLocalDraft(next); }
  function changeEditing(value: boolean) { if (remembered) remembered.editing = value; setEditHere(value); }
  useEffect(() => {
    if (!record && editHere) changeEditing(false);
  }, [record, editHere]);
  useEffect(() => {
    if (initialLine && (!remembered || remembered.jump !== (fileJump ?? 0))) setMode('source');
  }, [initialLine, fileJump]);
  useEffect(() => { setSaveError(null); setFindOpen(false); setFindQuery(''); }, [file?.path]);
  useEffect(() => {
    if (!copyNotice) return;
    const timer = window.setTimeout(() => setCopyNotice(undefined), 1800);
    return () => window.clearTimeout(timer);
  }, [copyNotice]);
  const copyable = Boolean(
    draft && file && file.kind !== 'binary' && file.kind !== 'pdf' && format !== 'unsupported',
  );
  const pathParts = splitPreviewPath(file?.path || '');
  const sourceText = file?.text || '';
  const matchCount = findQuery ? (sourceText.match(new RegExp(findQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length : 0;

  function findNext(backward = false) {
    if (!findQuery) return;
    const next = backward ? Math.max(0, findIndex - 1) : Math.min(Math.max(0, matchCount - 1), findIndex + 1);
    setFindIndex(next);
    try { (window as Window & { find?: (query: string, caseSensitive?: boolean, backwards?: boolean) => boolean }).find?.(findQuery, false, backward); } catch { /* 浏览器可能禁用 find */ }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.isComposing || event.altKey || event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
      if (!paneRef.current?.contains(target) || target?.closest('.studio-source-editor')) return;
      event.preventDefault();
      setFindOpen(true);
      window.setTimeout(() => paneRef.current?.querySelector<HTMLInputElement>('.file-preview-find input')?.focus(), 0);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function copySource() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopyNotice({ message: '已复制文件内容' });
    } catch {
      setCopyNotice({ message: '复制失败，请重试' });
    }
  }

  async function saveDraft() {
    if (!onSave || !editBase || saving || loading || changedOnDisk || refreshError) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft, editBase.text || '');
      const newer = currentEdit?.();
      if (newer && newer.text !== draft) changeDraft({ base: { ...editBase, text: draft }, text: newer.text });
      else { changeDraft(); changeEditing(false); }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !file) return <LoadingState variant="panel">正在读取文件…</LoadingState>;

  let body: ReactNode;
  if (!file) {
    body = <div className="file-preview-empty">
      <span><FileFormatIcon format="code" /></span>
      <strong>{emptyTitle}</strong>
      {emptyDescription && <p>{emptyDescription}</p>}
    </div>;
  } else {
    body = <PreviewBody file={file} format={format} mode={activeMode} text={draft} onOpenExternal={onOpenExternal}
      source={value => <Suspense fallback={<LoadingState variant="panel">正在加载源码编辑器…</LoadingState>}>
        <SourceEditor path={file.path} label={`${file.name} 源码编辑器`} text={value} editing={editing && activeMode === 'source' && !saving}
          lineNumbers={showLineNumbers} view={activeMode === 'source' ? sourceView : undefined}
          onChange={text => { if (editBase) changeDraft({ base: editBase, text }); }} onSave={() => { if (editing) void saveDraft(); }} />
      </Suspense>} />;
  }

  const menuItems: MenuAction[] = [];
  if (copyable) menuItems.push({ label: '复制文件内容', run: copySource });
  if (file?.kind === 'text' && activeMode === 'source' && format !== 'unsupported') {
    menuItems.push({ label: '显示行号', checked: showLineNumbers, run: () => {
      if (remembered) remembered.lineNumbers = !showLineNumbers;
      setShowLineNumbers(!showLineNumbers);
    } });
  }
  menuItems.push(...fileActions);
  return <div className="file-preview-pane" ref={paneRef}>
    <header className="file-preview-toolbar">
      {onBack && <button type="button" className="icon-button file-preview-back" aria-label="返回上一位置" title="返回上一位置" onClick={onBack}><ArrowLeft aria-hidden="true" /></button>}
      <div className="file-preview-identity">
        {file ? <FileKindIcon path={file.path} mime={file.mimeType} /> : <FileFormatIcon format={format} />}
        <strong title={pathParts.name}>{file?.name || emptyTitle}</strong>
        {file && <div className="file-preview-meta">
          <span className="file-preview-directory" title={file.path}>{pathParts.directory || '根目录'}</span>
          <span className="file-preview-format">{previewTypeLabel(file.path)}</span>
          <span className="file-preview-size">{formatFileSize(file.size)}</span>
        </div>}
      </div>
      <div className="file-preview-actions">
        {file && toggleable && <div className="file-preview-mode" role="group" aria-label="预览方式">
          <button type="button" aria-label="预览渲染结果" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>预览</button>
          <button type="button" aria-label="查看文件源码" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>源码</button>
        </div>}
        {file && editable && !editing && <button type="button" className="file-preview-command" aria-label="编辑文件" disabled={loading || Boolean(refreshError)} onClick={() => {
          onEdit?.();
          if (!record) changeDraft({base:file,text:file.text ?? ''});
          changeEditing(true);
          setMode('source');
          setSaveError(null);
        }}>编辑</button>}
        {editing && <>
          <button type="button" className="file-preview-command file-preview-save" aria-label="保存文件" disabled={saving || loading || Boolean(changedOnDisk || refreshError)} onClick={() => void saveDraft()}>{saving && <LoadingIndicator />}保存</button>
          <button type="button" className="file-preview-command" aria-label="取消编辑" disabled={saving} onClick={() => { changeDraft(); changeEditing(false); setSaveError(null); }}>取消</button>
        </>}
        {onSplit && <button type="button" className="file-preview-command" aria-label="在右侧打开" title="在右侧打开" onClick={onSplit}>分栏</button>}
        {file && file.kind !== 'text' && file.kind !== 'binary' && format !== 'unsupported' && !openWith && onOpenExternal &&
          <button type="button" className="file-preview-command" aria-label="用系统应用打开文件" onClick={() => onOpenExternal(file)}>用系统应用打开</button>}
        <FilePreviewMenu items={menuItems} openWith={openWith} />
      </div>
    </header>
    {file?.truncated && <div className="file-preview-banner"><AlertTriangle />文件较大，仅显示开头 1.5 MB。复制内容也只包含预览部分。</div>}
    {refreshError && <div className="file-preview-banner file-preview-refresh-error" role="alert">
      <AlertTriangle aria-hidden="true" /><span>读取最新内容失败。{refreshError.message}</span>
      <button type="button" className="text-button" onClick={refreshError.onRetry}>重试读取文件</button>
    </div>}
    {changedOnDisk && !saving && <div className="file-preview-banner" role="status">
      <AlertTriangle aria-hidden="true" />文件已更新，当前草稿已保留。取消编辑后可查看最新内容。
    </div>}
    <section className="file-preview-body" aria-label={file ? `${file.name} 文件预览` : '文件预览'}>
      {findOpen && <div className="conversation-search file-preview-find" role="search">
        <Search aria-hidden="true" />
        <input value={findQuery} onChange={(event) => { setFindQuery(event.target.value); setFindIndex(0); }} placeholder="搜索文件内容" aria-label="搜索文件内容" />
        <span>{findQuery ? `${matchCount ? findIndex + 1 : 0}/${matchCount}` : '搜索'}</span>
        <button type="button" className="icon-button" aria-label="上一个匹配" title="上一个" disabled={!matchCount} onClick={() => findNext(true)}><ChevronUp /></button>
        <button type="button" className="icon-button" aria-label="下一个匹配" title="下一个" disabled={!matchCount} onClick={() => findNext(false)}><ChevronDown /></button>
        <button type="button" className="icon-button" aria-label="关闭搜索" title="关闭搜索" onClick={() => setFindOpen(false)}><X /></button>
      </div>}
      {body}
      {copyNotice && <div className="file-preview-copy-notice" role="status">{copyNotice.message}</div>}
      {saveError && <div className="file-preview-save-error" role="alert">保存失败：{saveError}</div>}
      {loading && <LoadingState className="file-preview-loading">正在读取…</LoadingState>}
    </section>
  </div>;
}
