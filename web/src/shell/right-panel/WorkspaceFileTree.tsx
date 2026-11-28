import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { FileKindIcon, FolderKindIcon } from '../../shared/FileKindIcon';
import { ActionMenu, type MenuAction } from '../../shared/ActionMenu';
import { errorText } from '../../shared/error-text';
import { workspaceFilePath } from '../session-layout';

type Entry = Awaited<ReturnType<typeof window.piApi.files>>['entries'][number];
type Directory = { entries: Entry[] } | { error: string };
type TreeRow = { path: string; name: string; parent: string; directory: boolean; depth: number; position: number; siblings: number; status?: 'loading' | 'empty' | 'error' };
const rowHeight = 26;

export function WorkspaceFileTree({ cwd, expanded, toggle, selected, open, actions, excludePath }: {
  cwd: string; expanded: string[]; toggle: (path: string) => void; selected?: string;
  open: (path: string, preview: boolean) => void;
  actions?: (path: string) => MenuAction[]; excludePath?: string;
}) {
  const [menu, setMenu] = useState<{path: string; x: number; y: number}>();
  const [directories, setDirectories] = useState(new Map<string, Directory>());
  const pending = useRef(new Set<string>());
  const [focused, setFocused] = useState<string>();
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const treeId = useId();
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  const { rows, missing } = useMemo(() => {
    const rows: TreeRow[] = [], missing: string[] = [];
    function visit(dir: string, depth: number) {
      const directory = directories.get(dir);
      const entries = directory && 'entries' in directory ? directory.entries : [];
      const visible = excludePath ? entries.filter(entry => workspaceFilePath(cwd, entry.path) !== excludePath) : entries;
      if (!visible.length) {
        if (!directory) missing.push(dir);
        rows.push({ path: dir, parent: dir, directory: false, depth, position: 1, siblings: 1,
          status: !directory ? 'loading' : 'error' in directory ? 'error' : 'empty',
          name: !directory ? '正在读取…' : 'error' in directory ? directory.error : entries.length ? '没有其他文件' : '目录为空' });
        return;
      }
      visible.forEach((entry, index, siblings) => {
        const folder = entry.type === 'directory';
        rows.push({ path: entry.path, name: entry.name, parent: dir, depth, directory: folder, position: index + 1, siblings: siblings.length });
        if (folder && expandedSet.has(entry.path)) visit(entry.path, depth + 1);
      });
    }
    visit('', 0);
    return { rows, missing };
  }, [cwd, directories, expandedSet, excludePath]);

  useEffect(() => {
    function invalidate() {
      pending.current = new Set();
      setDirectories(new Map());
    }
    const off = window.piApi.onWorkbenchRefresh?.(event => {
      if (event.scope === 'all' || event.scope === 'files') invalidate();
    });
    return () => { off?.(); pending.current = new Set(); };
  }, [cwd]);
  useEffect(() => {
    const requests = pending.current;
    function store(path: string, result: Directory) {
      if (requests !== pending.current) return;
      requests.delete(path);
      setDirectories(previous => new Map(previous).set(path, result));
    }
    for (const path of missing) {
      if (requests.has(path)) continue;
      requests.add(path);
      void window.piApi.files(cwd, path).then(data => store(path, { entries: data.entries }), cause => store(path, { error: errorText(cause) }));
    }
  }, [cwd, missing]);
  useLayoutEffect(() => {
    const el = viewport.current!;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const focusIndex = rows.findIndex(row => !row.status && row.path === (focused ?? selected));
  const index = focusIndex < 0 ? rows.findIndex(row => !row.status) : focusIndex;
  const visibleCount = Math.ceil(view.height / rowHeight) + 12;
  const start = Math.max(0, Math.min(rows.length - visibleCount, Math.floor(view.top / rowHeight) - 6));
  const stop = Math.min(rows.length, start + visibleCount);
  function focus(at: number) {
    if (at < 0 || at >= rows.length) return;
    const el = viewport.current!;
    if (at * rowHeight < el.scrollTop) el.scrollTop = at * rowHeight;
    else if ((at + 1) * rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = (at + 1) * rowHeight - el.clientHeight;
    setFocused(rows[at].path);
    setView({ top: el.scrollTop, height: el.clientHeight });
  }
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== viewport.current || event.altKey || event.metaKey || event.ctrlKey || index < 0) return;
    const row = rows[index];
    if (actions && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) && !row.directory && !row.status) {
      event.preventDefault();
      const rect = document.getElementById(treeId + index)?.getBoundingClientRect();
      if (rect) setMenu({ path: row.path, x: rect.left + 20, y: rect.bottom });
      return;
    }
    switch (event.key) {
      case 'ArrowDown': case 'ArrowUp': case 'Home': case 'End': {
        const step = event.key === 'ArrowDown' || event.key === 'Home' ? 1 : -1;
        let at = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index + step;
        while (rows[at]?.status) at += step;
        focus(at);
        break;
      }
      case 'ArrowRight':
        if (row.directory && !expandedSet.has(row.path)) toggle(row.path);
        else if (rows[index + 1]?.parent === row.path && !rows[index + 1].status) focus(index + 1);
        break;
      case 'ArrowLeft':
        if (row.directory && expandedSet.has(row.path)) toggle(row.path);
        else focus(rows.findIndex(item => item.path === row.parent && !item.status));
        break;
      case 'Enter': case ' ':
        if (row.directory) toggle(row.path);
        else open(row.path, event.key === ' ');
        break;
      default: return;
    }
    event.preventDefault();
  }
  return <div ref={viewport} className="file-tree explorer-tree" role="tree" aria-label="工作区文件" tabIndex={0}
    aria-activedescendant={index >= start && index < stop ? treeId + index : undefined} onKeyDown={navigate}
    onScroll={event => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
    <div role="presentation" style={{ height: rows.length * rowHeight, position: 'relative' }}>
      <div role="presentation" style={{ position: 'absolute', insetInline: 0, top: start * rowHeight }}>
        {rows.slice(start, stop).map((row, offset) => {
          const at = start + offset;
          if (row.status) return <div key={'status:' + row.path} className="explorer-tree-note" role="status" style={{height: rowHeight, paddingInlineStart: 24 + 14 * row.depth}}>
            {row.name}{row.status === 'error' && <button onClick={() => setDirectories(previous => { const next = new Map(previous); next.delete(row.path); return next; })}>重试</button>}
          </div>;
          const shown = expandedSet.has(row.path);
          return <button type="button" role="treeitem" key={row.path} id={treeId + at} tabIndex={-1} className="file-row explorer-row"
            aria-level={row.depth + 1} aria-posinset={row.position} aria-setsize={row.siblings} aria-expanded={row.directory ? shown : undefined}
            aria-selected={selected === row.path} data-focused={at === index || undefined} title={row.path}
            style={{ height: rowHeight, '--indent': (5 + row.depth * 14) + 'px' } as CSSProperties}
            onClick={() => { setFocused(row.path); viewport.current?.focus({preventScroll:true}); if (row.directory) toggle(row.path); else open(row.path, false); }}
            onContextMenu={event => {
              if (!actions || row.directory) return;
              event.preventDefault(); setFocused(row.path);
              setMenu({ path: row.path, x: event.clientX, y: event.clientY });
            }}>
            <i className="explorer-disclosure" aria-hidden="true">{row.directory && (shown ? <ChevronDown /> : <ChevronRight />)}</i>
            {row.directory ? <FolderKindIcon path={row.path} expanded={shown} /> : <FileKindIcon path={row.path} />}
            <span>{row.name}</span>
          </button>;
        })}
      </div>
    </div>
    {menu && actions && <ActionMenu x={menu.x} y={menu.y} items={actions(menu.path)} onClose={() => setMenu(undefined)} />}
  </div>;
}
