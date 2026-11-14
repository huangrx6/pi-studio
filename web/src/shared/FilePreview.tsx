import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  LoaderCircle,
  ListOrdered,
  Pencil,
  Save,
  Search,
  X,
} from 'lucide-react';
import {
  markdownCodeFence,
  parseDelimitedPreview,
  prettyJson,
  previewExtension,
  previewFormatForFile,
  previewLanguageForFile,
  previewTypeLabel,
  splitPreviewPath,
} from './file-preview.mjs';
import type { FilePreviewResult } from '../types/file-preview-types';
import { Markdown } from './Markdown';
import { formatFileSize } from './filesize';
import { FileFormatIcon, type FilePreviewFormat } from './FileKindIcon';
import './file-preview.css';

type PreviewMode = 'preview' | 'source';

export type FilePreviewProps = {
  file: FilePreviewResult | null;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  onOpenExternal?: (file: FilePreviewResult) => void;
  editable?: boolean;
  onSave?: (text: string) => Promise<void>;
  /** 调用方自带的工具栏动作（例如工作台的“文件操作”菜单）。 */
  actions?: ReactNode;
};

function SourceCode({
  text,
  language,
  plain = false,
  showLineNumbers = false,
}: {
  text: string;
  language: string;
  plain?: boolean;
  showLineNumbers?: boolean;
}) {
  const fenced = useMemo(
    () => plain ? '' : markdownCodeFence(text, language),
    [language, plain, text],
  );
  const lines = Math.max(1, text.split('\n').length);
  const numbers = showLineNumbers && <div className="file-preview-line-numbers" aria-hidden="true">{Array.from({ length: lines }, (_, index) => <span key={index}>{index + 1}</span>)}</div>;
  if (plain) {
    return <div className={`file-preview-code file-preview-plain-code ${showLineNumbers ? 'has-line-numbers' : ''}`}>{numbers}<pre><code>{text}</code></pre></div>;
  }
  return <div className={`file-preview-code ${showLineNumbers ? 'has-line-numbers' : ''}`}>{numbers}<div className="file-preview-code-content"><Markdown codeChrome={false}>{fenced}</Markdown></div></div>;
}

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
  editing,
  draft,
  showLineNumbers,
  onDraftChange,
}: {
  file: FilePreviewResult;
  format: FilePreviewFormat;
  mode: PreviewMode;
  onOpenExternal?: (file: FilePreviewResult) => void;
  editing: boolean;
  draft: string;
  showLineNumbers: boolean;
  onDraftChange: (text: string) => void;
}) {
  const text = file.text || '';
  const json = useMemo(() => format === 'json' ? prettyJson(text) : null, [format, text]);
  const language = previewLanguageForFile(file.path);

  if (file.kind === 'binary' || format === 'unsupported') {
    return <div className="file-preview-unsupported">
      <span><FileFormatIcon format={format} /></span>
      <strong>{previewTypeLabel(file.path)} 暂不支持内嵌预览</strong>
      {file.unavailableReason && <p>{file.unavailableReason}</p>}
      {onOpenExternal && <button type="button" className="settings-outline" onClick={() => onOpenExternal(file)}>
        <ExternalLink />用系统应用打开
      </button>}
    </div>;
  }

  if (format === 'image' || format === 'audio' || format === 'video') {
    return <MediaPreview file={file} format={format} />;
  }

  if (mode === 'source') {
    const source = json?.ok ? json.text : text;
    if (editing) return <textarea className="file-preview-editor" value={draft} onChange={(event) => onDraftChange(event.target.value)} spellCheck={false} aria-label={`${file.name} 源码编辑器`} />;
    return <SourceCode text={source} language={language} plain={format === 'text'} showLineNumbers={showLineNumbers} />;
  }

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
      <SourceCode text={json.text} language="json" />
    </div>;
  }

  return <SourceCode text={text} language={format === 'code' ? language : 'text'} plain={format === 'text'} />;
}

/**
 * Shared file preview surface with optional workspace editing.
 *
 * The component never reads paths or executes file-provided markup. It renders
 * only a classified JSON-safe payload and uses a single toolbar/state model for
 * every supported format.
 */
export function FilePreview({
  file,
  loading = false,
  emptyTitle = '选择一个文件',
  emptyDescription = '',
  onOpenExternal,
  editable = false,
  onSave,
  actions,
}: FilePreviewProps) {
  const [mode, setMode] = useState<PreviewMode>('preview');
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(file?.text || '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showLineNumbers, setShowLineNumbers] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const paneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMode('preview');
    setCopied(false);
    setEditing(false);
    setDraft(file?.text || '');
    setSaveError(null);
    setFindOpen(false);
    setFindQuery('');
    setFindIndex(0);
  }, [file?.path]);

  useEffect(() => {
    if (!file || editing) return;
    setDraft(file.text || '');
  }, [editing, file?.text, file?.path]);

  const format = file
    ? previewFormatForFile(file.path, file.mimeType, file.kind) as FilePreviewFormat
    : 'text';
  const toggleable = format === 'markdown' || format === 'csv' || format === 'html';
  const copyable = Boolean(
    file?.text && file.kind !== 'binary' && file.kind !== 'pdf' && format !== 'unsupported',
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
      if (!paneRef.current?.contains(target)) return;
      event.preventDefault();
      setFindOpen(true);
      window.setTimeout(() => paneRef.current?.querySelector<HTMLInputElement>('.file-preview-find input')?.focus(), 0);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function copySource() {
    if (!file?.text) return;
    try {
      await navigator.clipboard.writeText(file.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  async function saveDraft() {
    if (!onSave || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  let body: ReactNode;
  if (!file) {
    body = <div className="file-preview-empty">
      <span><FileFormatIcon format="code" /></span>
      <strong>{emptyTitle}</strong>
      {emptyDescription && <p>{emptyDescription}</p>}
    </div>;
  } else {
    body = <PreviewBody file={file} format={format} mode={mode} onOpenExternal={onOpenExternal} editing={editing} draft={draft} showLineNumbers={showLineNumbers} onDraftChange={setDraft} />;
  }

  return <div className="file-preview-pane" ref={paneRef}>
    <header className="file-preview-toolbar">
      <div className="file-preview-identity">
        <span className="file-preview-icon"><FileFormatIcon format={format} /></span>
        <div>
          <strong title={pathParts.name}>{file?.name || emptyTitle}</strong>
          {file && <span title={file.path}>{pathParts.directory || '根目录'}</span>}
        </div>
      </div>
      <div className="file-preview-actions">
        {file && <span className="file-preview-format">{previewTypeLabel(file.path)}</span>}
        {file && <span className="file-preview-size">{formatFileSize(file.size)}</span>}
        {file && toggleable && <div className="file-preview-mode" role="group" aria-label="预览方式">
          <button
            type="button"
            className={`icon-button ${mode === 'preview' ? 'is-active' : ''}`}
            aria-label="预览渲染结果"
            aria-pressed={mode === 'preview'}
            title="渲染预览"
            onClick={() => setMode('preview')}
          ><Eye /></button>
          <button
            type="button"
            className={`icon-button ${mode === 'source' ? 'is-active' : ''}`}
            aria-label="查看文件源码"
            aria-pressed={mode === 'source'}
            title="查看源码"
            onClick={() => setMode('source')}
          ><Code2 /></button>
        </div>}
        {file && mode === 'source' && file.kind !== 'binary' && format !== 'pdf' && format !== 'unsupported' && <button type="button" className={`icon-button ${showLineNumbers ? 'is-active' : ''}`} aria-label={showLineNumbers ? '隐藏行号' : '显示行号'} aria-pressed={showLineNumbers} title={showLineNumbers ? '隐藏行号' : '显示行号'} onClick={() => setShowLineNumbers((value) => !value)}><ListOrdered /></button>}
        {file && editable && !editing && <button type="button" className="icon-button" aria-label="编辑文件" title="编辑文件" onClick={() => { setMode('source'); setEditing(true); setSaveError(null); }}><Pencil /></button>}
        {file && editable && editing && <>
          <button type="button" className="icon-button" aria-label="保存文件" title="保存文件" disabled={saving} onClick={() => void saveDraft()}>{saving ? <LoaderCircle className="spin" /> : <Save />}</button>
          <button type="button" className="icon-button" aria-label="取消编辑" title="取消编辑" disabled={saving} onClick={() => { setDraft(file.text || ''); setEditing(false); setSaveError(null); }}><X /></button>
        </>}
        {actions}
        {copyable && <button type="button" className="icon-button" aria-label={copied ? '已复制文件内容' : '复制文件内容'} title="复制内容" onClick={() => void copySource()}>
          {copied ? <Check /> : <Copy />}
        </button>}
        {file && (file.kind === 'binary' || file.kind === 'pdf') && onOpenExternal && <button type="button" className="icon-button" aria-label="用系统应用打开文件" title="用系统应用打开" onClick={() => onOpenExternal(file)}>
          <ExternalLink />
        </button>}
      </div>
    </header>
    {file?.truncated && <div className="file-preview-banner"><AlertTriangle />文件较大，仅显示开头 1.5 MB。复制内容也只包含预览部分。</div>}
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
      {saveError && <div className="file-preview-save-error" role="alert">保存失败：{saveError}</div>}
      {loading && <div className="file-preview-loading" role="status"><LoaderCircle className="spin" />正在读取…</div>}
    </section>
  </div>;
}
