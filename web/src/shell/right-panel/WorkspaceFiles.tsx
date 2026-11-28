import { useEffect, useRef, useState } from 'react';
import { CaseSensitive, ChevronDown, ChevronRight, FileSearch, ListFilter, Regex, Search, TextSearch, WholeWord, X } from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { FileKindIcon } from '../../shared/FileKindIcon';
import { PanelViewSwitcher } from '../../shared/PanelViewSwitcher';
import { errorText } from '../../shared/error-text';
import type { FileContentMatches, FileContentResults, FileSearchOptions } from '../../types/workspace';
import { isComposingKey, menuFocusIndex } from '../../shared/keyboard-navigation';
import type { FileTab, FileTreeState, SessionLayout } from '../session-layout';
import { WorkspaceFileTree } from './WorkspaceFileTree';
import './styles/workspace-files.css';

type Open = (path: string, preview: boolean, line?: number) => void;
const modes = [['name', '名称', FileSearch], ['content', '内容', TextSearch]] as const;
const flags = [['caseSensitive', '区分大小写', CaseSensitive], ['wholeWord', '全字匹配', WholeWord], ['regex', '正则表达式', Regex]] as const;
const defaultOptions: FileSearchOptions = {};
const defaultExpanded: string[] = [];

function PathLabel({ path }: { path: string }) {
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return <><FileKindIcon path={path} /><span className="explorer-basename">{path.slice(split + 1)}</span>
    {split >= 0 && <small className="explorer-dirname">{path.slice(0, split)}</small>}</>;
}

function MatchGroup({ file, open }: { file: FileContentMatches; open: Open }) {
  const [expanded, setExpanded] = useState(true);
  return <section className="explorer-match-group">
    <button type="button" className="explorer-path" aria-expanded={expanded} title={file.path} onClick={() => setExpanded(value => !value)}>
      <i className="explorer-disclosure">{expanded ? <ChevronDown /> : <ChevronRight />}</i>
      <PathLabel path={file.path} /><small className="explorer-count">{file.count}</small>
    </button>
    {expanded && file.rows.map((row, index) => <button type="button" key={index} className="explorer-hit"
      title={file.path + ':' + row.line} onClick={() => open(file.path, true, row.line)} onDoubleClick={() => open(file.path, false, row.line)}>
      <span className="explorer-line">{row.line}</span><code>{row.parts.map((part, at) => part.match
        ? <mark key={at}>{part.text}</mark> : part.text)}</code>
    </button>)}
  </section>;
}

function SearchResults({ cwd, mode, query, options, open, excludePath }: {
  cwd: string; mode: FileTreeState['mode']; query: string; options: FileSearchOptions; open: Open; excludePath?: string;
}) {
  const [result, setResult] = useState<FileContentResults | string[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, started = false;
    const requestId = crypto.randomUUID();
    const timer = setTimeout(async () => {
      started = true;
      try {
        const next = mode === 'content'
          ? await window.piApi.searchFileContents({ cwd, query, options, requestId })
          : (await window.piApi.searchFiles({ cwd, query })).files.filter(file => file.type === 'file' && file.path !== excludePath).map(file => file.path);
        if (active) setResult(next);
      } catch (cause) {
        if (active) setError(errorText(cause));
      }
    }, 170);
    return () => {
      active = false;
      clearTimeout(timer);
      if (started && mode === 'content') window.piApi.cancelFileContentSearch(requestId);
    };
  }, [cwd, mode, query, options, excludePath]);
  if (error) return <p className="explorer-message" role="alert">{error}</p>;
  if (!result) return <p className="explorer-message" role="status">正在搜索…</p>;
  const count = Array.isArray(result) ? result.length : result.count;
  if (!count) return <p className="explorer-message" role="status">没有匹配结果</p>;
  return <div className="explorer-results">
    {Array.isArray(result) ? result.map(path => <button key={path} type="button" className="explorer-path" title={path}
      onClick={() => open(path, true)} onDoubleClick={() => open(path, false)}><PathLabel path={path} /></button>) : <>
      <p className="explorer-summary" role="status">{result.truncated && '仅显示前 '}{count} 处匹配 · {result.files.length} 个文件</p>
      {result.files.map(file => <MatchGroup key={file.path} file={file} open={open} />)}
    </>}
  </div>;
}

export function ComparisonFileDialog({ source, layout, onChoose, onClose }: {
  source: FileTab; layout: SessionLayout; onChoose: (path: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  const choices = useRef<HTMLDivElement>(null);
  const term = query.trim();
  const opened = new Set<string>();
  for (const tab of [...layout.tabs, ...(layout.right?.tabs ?? [])]) {
    if (tab.kind === 'file' && tab.source === 'workspace' && tab.cwd === source.cwd && tab.path !== source.path) opened.add(tab.path);
  }
  return <DetailDialog label="选择比较文件" className="comparison-file-picker workspace-files" onClose={onClose}>{close => <>
    <header className="detail-header">
      <div className="detail-heading"><div><h2>选择比较文件</h2><p title={source.path}>原文件 · {source.path}</p></div></div>
      <button type="button" className="icon-button" aria-label="关闭" onClick={close}><X /></button>
    </header>
    <label className="explorer-search explorer-fields comparison-file-search">
      <Search aria-hidden="true" />
      <input type="search" autoFocus aria-label="搜索比较文件" placeholder="搜索文件名或路径" value={query}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (isComposingKey(event.nativeEvent) || (event.key !== 'Enter' && event.key !== 'ArrowDown')) return;
          const first = choices.current?.querySelector<HTMLElement>('.explorer-path, [role="tree"]');
          if (!first) return;
          event.preventDefault();
          if (event.key === 'Enter' && first instanceof HTMLButtonElement) first.click();
          else first.focus();
        }} />
    </label>
    <div className="comparison-file-choices" ref={choices} onKeyDown={event => {
      if (!(event.target instanceof HTMLButtonElement) || !event.target.matches('.explorer-path') || isComposingKey(event.nativeEvent)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.explorer-path'));
      const next = menuFocusIndex(event.key, buttons.indexOf(event.target), buttons.length);
      if (next !== null) { event.preventDefault(); buttons[next].focus(); }
    }}>
      {term ? <SearchResults key={term} cwd={source.cwd} mode="name" query={term} options={defaultOptions} excludePath={source.path} open={onChoose} /> : <>
        {opened.size > 0 && <><h3>已打开</h3><div className="comparison-open-files">{[...opened].map(path =>
          <button key={path} type="button" className="explorer-path" title={path} onClick={() => onChoose(path)}><PathLabel path={path} /></button>)}</div></>}
        <h3>工作区文件</h3>
        <WorkspaceFileTree cwd={source.cwd} excludePath={source.path} expanded={expanded} open={onChoose}
          toggle={path => setExpanded(paths => paths.includes(path) ? paths.filter(item => item !== path) : [...paths, path])} />
      </>}
    </div>
  </>}</DetailDialog>;
}

export function WorkspaceFiles({ cwd, selected, open, state, update, actions }: {
  actions: (path: string) => import('../../shared/ActionMenu').MenuAction[];
  cwd: string; selected?: string; open: Open; state?: FileTreeState; update: (patch: Partial<FileTreeState>) => void;
}) {
  const { mode = 'name', query = '', expanded = defaultExpanded, options = defaultOptions } = state ?? {};
  const [filters, setFilters] = useState(Boolean(options.include || options.exclude));
  const input = useRef<HTMLInputElement>(null);
  const term = mode === 'content' ? query : query.trim();
  const updateOptions = (patch: FileSearchOptions) => update({ options: { ...options, ...patch } });
  if (!cwd) return <div className="panel-empty">选择工作区后可浏览文件。</div>;
  return <div className="panel-file-browser workspace-files">
    <div className="explorer-toolbar">
      <PanelViewSwitcher label="文件搜索范围" choices={modes} value={mode} onChange={next => { update({ mode: next }); input.current?.focus(); }} />
    </div>
    <div className="explorer-fields">
      <div className="explorer-search-row">
        <div className="explorer-search">
          <Search aria-hidden="true" />
          <input ref={input} type="search" aria-label="搜索工作区文件" placeholder={mode === 'name' ? '查找文件' : '搜索文件内容'}
            value={query} onChange={event => update({ query: event.target.value })} />
          {mode === 'content' && <div className="explorer-flags">{flags.map(([key, title, Icon]) =>
            <button type="button" key={key} aria-pressed={Boolean(options[key])} title={title} aria-label={title}
              onClick={() => { updateOptions({ [key]: !options[key] }); input.current?.focus(); }}><Icon /></button>)}</div>}
        </div>
        {mode === 'content' && <button type="button" className="icon-button explorer-filter-toggle" aria-label="筛选文件范围" title="筛选文件范围"
          aria-expanded={filters} data-filtered={Boolean(options.include || options.exclude) || undefined}
          onClick={() => setFilters(value => !value)}><ListFilter /></button>}
      </div>
      {filters && mode === 'content' && <div className="explorer-filters">
        <label>包含文件<input placeholder="例如 src/**/*.ts" value={options.include ?? ''} onChange={e => updateOptions({ include: e.target.value })} /></label>
        <label>排除文件<input placeholder="例如 **/*.test.ts" value={options.exclude ?? ''} onChange={e => updateOptions({ exclude: e.target.value })} /></label>
      </div>}
    </div>
    {term ? <SearchResults key={JSON.stringify([cwd, mode, term, options])} cwd={cwd} mode={mode} query={term} options={options} open={open} />
      : mode === 'name' ? <WorkspaceFileTree cwd={cwd} selected={selected} expanded={expanded} open={open} actions={actions}
          toggle={path => update({ expanded: expanded.includes(path) ? expanded.filter(item => item !== path) : [...expanded, path] })} />
      : <p className="explorer-message">输入关键词，搜索工作区文件内容。</p>}
  </div>;
}
