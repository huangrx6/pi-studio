import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { isComposingKey, menuFocusIndex } from '../../shared/keyboard-navigation';
import { PopoverSurface } from '../../shared/PopoverSurface';
import type { PanelTab } from '../app-types';

type SwitcherTab = Pick<PanelTab, 'id' | 'title' | 'path' | 'tooltip'>;

function searchKey(value: string) {
  return value.replaceAll('\\', '/').toLowerCase();
}

function tabLocation(tab: SwitcherTab, sharedPath: boolean) {
  const path = sharedPath && tab.tooltip ? tab.tooltip : tab.path || tab.tooltip || '';
  const nameStart = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  return path.slice(nameStart) === tab.title ? path.slice(0, nameStart) : path;
}

export function PanelTabSwitcher<T extends SwitcherTab>({
  tabs, activeId, renderIcon, onSelect,
}: {
  tabs: T[];
  activeId: string;
  renderIcon: (tab: T) => ReactNode;
  onSelect: (tab: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursorId, setCursorId] = useState('');
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const followCursor = useRef(true);
  const listId = useId();
  const triggerLabel = `查看全部 ${tabs.length} 个标签页`;
  const term = searchKey(query.trim());
  const matches = open && term
    ? tabs.filter(tab => [tab.title, tab.path, tab.tooltip].some(value => value && searchKey(value).includes(term)))
    : tabs;
  const index = Math.max(0, matches.findIndex(tab => tab.id === cursorId));
  const pathCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of tabs) {
      if (tab.path) counts.set(tab.path, (counts.get(tab.path) ?? 0) + 1);
    }
    return counts;
  }, [tabs]);

  function show() {
    setQuery('');
    setCursorId(activeId);
    followCursor.current = true;
    setOpen(true);
  }

  function select(tab: T) {
    setOpen(false);
    onSelect(tab);
  }

  useLayoutEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [open]);

  useLayoutEffect(() => {
    const row = list.current?.children[index] as HTMLElement | undefined;
    if (open && followCursor.current && row) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [open, index, query]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);

  return <div className="panel-tab-switcher" ref={anchor}>
    <button ref={trigger} type="button" className="panel-tab-count" aria-label={triggerLabel}
      title={triggerLabel} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${listId}-popup` : undefined}
      onClick={() => open ? setOpen(false) : show()}
      onKeyDown={event => {
        if (isComposingKey(event.nativeEvent)) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); }
      }}>
      {tabs.length}<ChevronDown aria-hidden="true" />
    </button>
    {open && <PopoverSurface id={`${listId}-popup`} className="panel-tab-popover" role="dialog" aria-label="切换标签页"
      onKeyDown={event => {
        if (isComposingKey(event.nativeEvent)) return;
        if (event.key === 'Escape' || event.key === 'Tab') {
          setOpen(false);
          trigger.current?.focus({ preventScroll: true });
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (matches[index]) select(matches[index]);
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const next = menuFocusIndex(event.key, index, matches.length, true);
        if (next !== null) {
          event.preventDefault();
          followCursor.current = true;
          setCursorId(matches[next].id);
        }
      }}>
      <label className="panel-tab-search"><Search aria-hidden="true" />
        <input ref={input} role="combobox" aria-label="搜索标签页" placeholder="搜索标签名或文件路径…" value={query}
          autoComplete="off" spellCheck={false} aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={matches[index] ? `${listId}-${index}` : undefined}
          onChange={event => { setQuery(event.target.value); setCursorId(''); followCursor.current = true; }} />
      </label>
      <div className="panel-tab-options" ref={list} id={listId} role="listbox" aria-label="已打开的标签页">
        {matches.map((tab, i) => {
          const location = tabLocation(tab, (pathCounts.get(tab.path ?? '') ?? 0) > 1);
          return <button key={tab.id} id={`${listId}-${i}`} type="button" role="option" tabIndex={-1}
            aria-selected={i === index} aria-current={tab.id === activeId ? 'page' : undefined} title={tab.tooltip || tab.path || tab.title}
            className="panel-tab-option" onMouseDown={event => event.preventDefault()}
            onMouseMove={() => { followCursor.current = false; setCursorId(tab.id); }} onClick={() => select(tab)}>
            {renderIcon(tab)}
            <span className="panel-tab-option-text"><span>{tab.title}</span>{location && <small><bdi>{location}</bdi></small>}</span>
            {tab.id === activeId && <Check className="panel-tab-current" aria-hidden="true" />}
          </button>;
        })}
      </div>
      {!matches.length && <p className="panel-tab-no-match" role="status">没有匹配的标签页</p>}
    </PopoverSurface>}
  </div>;
}
