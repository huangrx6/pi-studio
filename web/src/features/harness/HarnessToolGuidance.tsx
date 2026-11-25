import { useId, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Plus, Search, Terminal, Trash2, X } from 'lucide-react';
import { Accordion } from '../../shared/Accordion';
import { isComposingKey, menuFocusIndex } from '../../shared/keyboard-navigation';
import { toolGuidanceNameError, type GuidanceRow } from './harness-state';
import './styles/harness-tool-guidance.css';

function ToolNamePicker({ tools, used, onChoose, onCancel }: {
  tools: string[]; used: Set<string>; onChoose: (name: string) => void; onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listId = useId();
  const name = query.trim();
  const issue = name && toolGuidanceNameError(name, used);
  const search = name.toLowerCase();
  const options = tools.filter(tool => tool !== name && tool.toLowerCase().includes(search) && !toolGuidanceNameError(tool, used));
  const custom = Boolean(name && !issue && !tools.includes(name));
  if (name && !issue) {
    if (custom) options.push(name);
    else options.unshift(name);
  }
  const selected = Math.min(index, options.length - 1);

  return <div className="harness-tool-picker" onKeyDown={event => {
    if (event.key === 'Escape' && !isComposingKey(event.nativeEvent)) {
      event.preventDefault(); event.stopPropagation(); onCancel();
    }
  }}>
    <div className="harness-tool-search">
      <Search aria-hidden="true" />
      <input autoFocus role="combobox" aria-label="工具名称" aria-autocomplete="list" aria-expanded="true"
        aria-controls={listId} aria-activedescendant={selected >= 0 ? listId + '-' + selected : undefined}
        aria-describedby={issue ? listId + '-hint' : undefined}
        placeholder="搜索或输入工具名称" autoComplete="off" spellCheck={false} maxLength={120} value={query}
        onChange={event => { setQuery(event.target.value); setIndex(0); }}
        onKeyDown={event => {
          if (isComposingKey(event.nativeEvent)) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            if (selected >= 0) onChoose(options[selected]);
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next = menuFocusIndex(event.key, selected, options.length);
            if (next !== null) {
              setIndex(next);
              document.getElementById(listId + '-' + next)?.scrollIntoView({ block: 'nearest' });
            }
          }
        }} />
      <button type="button" className="icon-button" aria-label="取消选择工具" title="取消选择" onClick={onCancel}><X /></button>
    </div>
    <div className="harness-tool-options" id={listId} role="listbox" aria-label="工具名称">
      {options.map((tool, i) => <button key={tool} id={listId + '-' + i} type="button" role="option" tabIndex={-1}
        aria-selected={i === selected} onMouseMove={() => setIndex(i)} onMouseDown={event => event.preventDefault()} onClick={() => onChoose(tool)}>
        {custom && tool === name ? <><Plus aria-hidden="true" /><span>使用自定义名称</span></> : <Terminal aria-hidden="true" />}
        <code>{tool}</code>
      </button>)}
    </div>
    {(issue || !options.length) && <p id={listId + '-hint'} className="harness-picker-hint" role="status">{issue || '输入工具名称即可添加说明。'}</p>}
  </div>;
}

export function HarnessToolGuidance({ rows, enabledTools, onChange }: {
  rows: GuidanceRow[]; enabledTools: string[]; onChange: (rows: GuidanceRow[]) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [picking, setPicking] = useState<'add' | number | null>(null);
  const prefix = useId();
  const nextKey = useRef(rows.length);
  const note = useRef<HTMLTextAreaElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const tools = useMemo(() => [...new Set(enabledTools)].filter(tool => tool !== '*').sort((a, b) => a.localeCompare(b)), [enabledTools]);
  const missing = rows.filter(row => !row.guidance.trim()).length;
  const used = new Set(rows.filter(row => row.key !== picking).map(row => row.name));

  function focusAfterRender(ref: RefObject<HTMLElement>) {
    requestAnimationFrame(() => ref.current?.focus());
  }
  function focusRow(key?: number) {
    requestAnimationFrame(() => {
      const summary = key === undefined ? null : document.getElementById(prefix + '-' + key);
      (summary ?? addButton.current)?.focus();
    });
  }
  function choose(name: string) {
    if (picking === null || toolGuidanceNameError(name, used)) return;
    const key = picking === 'add' ? nextKey.current++ : picking;
    onChange(picking === 'add' ? [...rows, { key, name, guidance: '' }]
      : rows.map(row => row.key === key ? { ...row, name } : row));
    setPicking(null); setEditing(key); focusAfterRender(note);
  }
  function remove(row: GuidanceRow) {
    const at = rows.indexOf(row);
    onChange(rows.filter(item => item.key !== row.key));
    setPicking(null); setEditing(null); focusRow((rows[at + 1] || rows[at - 1])?.key);
  }
  const picker = <ToolNamePicker tools={tools} used={used} onChoose={choose} onCancel={() => {
    setPicking(null); focusAfterRender(picking === 'add' ? addButton : renameButton);
  }} />;

  return <Accordion className="harness-disclosure harness-guidance" summary="工具说明"
    badge={missing ? missing + ' 条待填写' : rows.length ? rows.length + ' 条自定义' : '使用内置说明'}>
    <div className="harness-guidance-list">
      {rows.map(row => editing === row.key
        ? <div key={row.key} className="harness-note-editor">
          <div className="harness-note-toolbar">
            <button ref={renameButton} className="harness-note-tool settings-row-link" type="button" title={'更换工具 ' + row.name} aria-label={'更换工具 ' + row.name}
              aria-expanded={picking === row.key} onClick={() => setPicking(picking === row.key ? null : row.key)}>
              <Terminal aria-hidden="true" /><code>{row.name}</code><ChevronDown className="settings-row-link-indicator" aria-hidden="true" />
            </button>
            <button type="button" className="icon-button harness-note-remove" aria-label={'删除 ' + row.name + ' 的工具说明'}
              title="删除工具说明" onClick={() => remove(row)}><Trash2 /></button>
            <button type="button" className="icon-button" aria-label={'收起 ' + row.name + ' 的工具说明'} title="收起说明"
              aria-expanded="true" aria-controls={prefix + '-note-' + row.key}
              onClick={() => { setPicking(null); setEditing(null); focusRow(row.key); }}><ChevronUp /></button>
          </div>
          {picking === row.key && picker}
          <textarea id={prefix + '-note-' + row.key} className="harness-note-text" ref={note} aria-label="使用说明" required rows={2} maxLength={1200}
            placeholder="写下使用这个工具时要遵循的要求…" value={row.guidance}
            onChange={event => onChange(rows.map(item => item.key === row.key ? { ...item, guidance: event.target.value } : item))} />
        </div>
        : <button key={row.key} type="button" id={prefix + '-' + row.key} className="harness-note-summary settings-row-link"
          aria-label={'编辑 ' + row.name + ' 的工具说明'} aria-describedby={prefix + '-preview-' + row.key} title={row.name} aria-expanded={false}
          onClick={() => { setPicking(null); setEditing(row.key); focusAfterRender(note); }}>
          <Terminal aria-hidden="true" /><code>{row.name}</code>
          <span id={prefix + '-preview-' + row.key}>{row.guidance.trim() || '待填写使用说明'}</span>
          <ChevronRight className="settings-row-link-indicator" aria-hidden="true" />
        </button>)}
      {picking === 'add' ? picker : <button type="button" ref={addButton} className="settings-text-button harness-add-guidance"
        disabled={rows.length >= 64} onClick={() => { setEditing(null); setPicking('add'); }}>
        <Plus aria-hidden="true" />添加工具说明
      </button>}
    </div>
  </Accordion>;
}
