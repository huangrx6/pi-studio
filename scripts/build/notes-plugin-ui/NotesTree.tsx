import { useEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from 'react';
import {
  Archive, ChevronRight, CircleHelp, Code2, Compass, FileText, Folder, FolderKanban,
  FolderOpen, Image, Inbox, LibraryBig, Plus, Search as SearchIcon, Settings2, X,
} from 'lucide-react';
import libraryIcon from '../../../assets/official-plugins/packages/notes-library/assets/icon.png';
import { label, type Entry, type Search, type Section, type Tree } from './bridge';
import { ResizableSidebar } from './ResizableOutline';
import { IconButton } from './Toolbar';

const SECTION_ICONS = {
  inbox: Inbox, projects: FolderKanban, areas: Compass, resources: LibraryBig,
  archive: Archive, assets: Image, system: Settings2,
};
const FILE_ICONS = { markdown: FileText, html: Code2, image: Image, pdf: FileText };

type Props = {
  tree: Tree;
  sections: Section[];
  selected: string;
  folder: string;
  searchRef: RefObject<HTMLInputElement>;
  query: string;
  search: Search | null;
  searching: boolean;
  onQuery: (query: string) => void;
  onOpen: (entry: Entry) => void;
  onFolder: (folder: string) => void;
  onManage: (entry: Entry) => void;
  onNew: (parent?: string) => void;
  onSettings: () => void;
  onDrop: (source: Entry, folder: string) => void;
  welcome: boolean;
  width: number;
  onResize: (width: number) => void;
};

export function NotesTree(props: Props) {
  const { tree, sections, selected, folder, searchRef, query, search, searching } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree.sections.inbox ? [tree.sections.inbox] : []));
  const [target, setTarget] = useState('');
  const drag = useRef<Entry>();
  const children = useMemo(() => {
    const grouped = new Map<string, Entry[]>();
    for (const entry of tree.entries) {
      const siblings = grouped.get(entry.parent) ?? [];
      siblings.push(entry);
      grouped.set(entry.parent, siblings);
    }
    const rank = (entry: Entry) => entry.section ? sections.findIndex(section => section.id === entry.section) : sections.length;
    for (const list of grouped.values()) list.sort((a, b) =>
      Number(b.kind === 'folder') - Number(a.kind === 'folder') || rank(a) - rank(b));
    return grouped;
  }, [sections, tree.entries]);
  const inbox = tree.sections.inbox;
  const pending = inbox ? tree.entries.filter(entry => entry.kind !== 'folder' && entry.path.startsWith(inbox + '/')).length : 0;
  useEffect(() => {
    if (!selected) return;
    const segments = selected.split('/').slice(0, -1);
    setExpanded(previous => new Set([...previous, ...segments.map((_part, index) => segments.slice(0, index + 1).join('/'))]));
  }, [selected]);

  function toggle(path: string) {
    const open = expanded.has(path);
    setExpanded(previous => {
      const next = new Set(previous);
      if (open) next.delete(path); else next.add(path);
      return next;
    });
    props.onFolder(path);
  }

  function dragOver(event: DragEvent, entry: Entry) {
    const moving = drag.current;
    if (entry.kind !== 'folder' || !moving || moving.path === entry.path || entry.path.startsWith(moving.path + '/')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setTarget(entry.path);
  }

  function onManageKey(event: React.KeyboardEvent, entry: Entry) {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    props.onManage(entry);
  }

  function row(entry: Entry, depth: number) {
    const isFolder = entry.kind === 'folder';
    const open = isFolder && expanded.has(entry.path);
    const Icon = isFolder
      ? SECTION_ICONS[entry.section as keyof typeof SECTION_ICONS] || (open ? FolderOpen : Folder)
      : FILE_ICONS[entry.kind as keyof typeof FILE_ICONS];
    const [, prefix, sectionName] = entry.section ? /^(\d+[\s._-]+)(.*)$/.exec(entry.name) ?? [] : [];
    const showFolderHighlight = isFolder && folder === entry.path && (!selected || !selected.startsWith(entry.path + '/'));
    return <li key={entry.path}>
      <div className="pane-row tree-row" data-section={entry.section} data-folder={isFolder || undefined}
        data-current={selected === entry.path || undefined}
        data-folder-selected={showFolderHighlight || undefined}
        data-drop={target === entry.path || undefined}
        style={{ paddingInlineStart: (isFolder ? 8 : 14) + Math.min(depth, 10) * 13 }}
        draggable={!entry.section}
        onDragStart={event => {
          drag.current = entry;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', entry.name);
        }}
        onDragEnd={() => { drag.current = undefined; setTarget(''); }}
        onDragOver={event => dragOver(event, entry)}
        onDragLeave={() => setTarget('')}
        onDrop={event => {
          event.preventDefault();
          const moving = drag.current;
          drag.current = undefined;
          setTarget('');
          if (moving && entry.kind === 'folder') props.onDrop(moving, entry.path);
        }}
        onContextMenu={event => { event.preventDefault(); props.onManage(entry); }}>
        <button type="button" className="tree-item" title={entry.name} aria-current={selected === entry.path ? 'page' : undefined}
          aria-keyshortcuts="Shift+F10" aria-expanded={isFolder ? open : undefined}
          onKeyDown={event => onManageKey(event, entry)} onClick={() => isFolder ? toggle(entry.path) : props.onOpen(entry)}>
          {isFolder && <span className="tree-caret"><ChevronRight size={12} /></span>}
          <Icon size={14} className="tree-icon" />
          <span className="entry-name">{prefix && <span className="section-prefix">{prefix}</span>}{sectionName || label(entry.name)}</span>
          {entry.path === inbox && pending > 0 && <span className="inbox-count" data-warm={pending >= 10}>{pending}</span>}
        </button>
        {isFolder && <IconButton className="tree-action" label={'在 ' + entry.name + ' 新建'}
          onClick={() => props.onNew(entry.path)}><Plus size={14} /></IconButton>}
      </div>
      {open && children.get(entry.path)?.length ? <ul>{children.get(entry.path)!.map(child => row(child, depth + 1))}</ul> : null}
    </li>;
  }

  return <ResizableSidebar width={props.width} onResize={props.onResize}>
    <header className="notes-pane-title sidebar-title">
      <img className="sidebar-mark" src={libraryIcon} width={20} height={20} alt="" />
      <strong>知识库</strong>
      <IconButton label="知识库设置" onClick={props.onSettings}><Settings2 size={15} /></IconButton>
      <IconButton className="sidebar-new" label="新建笔记" onClick={() => props.onNew()}><Plus size={16} /></IconButton>
    </header>
    <label className="notes-search">
      <SearchIcon size={14} />
      <input ref={searchRef} placeholder="搜索标题和正文" aria-label="搜索标题和正文" value={query}
        onChange={event => props.onQuery(event.target.value)} maxLength={160} />
      {query ? <button className="icon-button" type="button" title="清除搜索" aria-label="清除搜索" onClick={() => props.onQuery('')}><X size={13} /></button>
        : <kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd>}
    </label>
    <nav className="tree-content" aria-label={query.trim() ? '搜索结果' : 'PARA 目录'}>
      {query.trim() ? <>
        {searching && <p className="quiet-tree-note" role="status">正在搜索…</p>}
        {search?.matches.map(hit => <button type="button" className="search-hit" key={hit.path} aria-keyshortcuts="Shift+F10"
          onClick={() => props.onOpen(hit)} onKeyDown={event => onManageKey(event, hit)}
          onContextMenu={event => { event.preventDefault(); props.onManage(hit); }}>
          <span>{label(hit.name)}</span>{hit.parent && <small>{hit.parent.replaceAll('/', ' / ')}</small>}
          {hit.excerpt && <small className="search-excerpt">{hit.excerpt}</small>}
        </button>)}
        {!searching && search?.matches.length === 0 && <p className="quiet-tree-note">没有匹配的笔记</p>}
        {search?.partial && <p className="quiet-tree-note">已显示部分结果</p>}
      </> : <>
        <ul>{(children.get('') ?? []).map(entry => row(entry, 0))}</ul>
        {tree.partial && <p className="quiet-tree-note">已显示部分目录</p>}
        {props.welcome && <button className="tree-setup" type="button" onClick={props.onSettings}><CircleHelp size={14} />补齐 PARA 目录</button>}
      </>}
    </nav>
  </ResizableSidebar>;
}
