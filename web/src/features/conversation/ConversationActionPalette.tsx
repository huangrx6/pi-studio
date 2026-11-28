import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, MessageCirclePlus, Search, X } from 'lucide-react';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import { useModalDialog } from '../../shared/useModalDialog';
import { filterConversationActions, type ConversationAction } from './conversation-actions';
import './styles/conversation-actions.css';

const groups = { conversation: '当前会话', workspace: '工作区', extension: '扩展动作' };

export function ConversationActionPalette({ actions, loading, resourceError, onExecute, onClose }: {
  actions: ConversationAction[];
  loading: boolean;
  resourceError?: string;
  onExecute: (action: ConversationAction) => Promise<void>;
  onClose: () => void;
}) {
  const { dialogRef: dialog, onKeyDown: onDialogKeyDown, dismiss } = useModalDialog();
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const listId = useId();
  const titleId = useId();
  const filtered = filterConversationActions(actions, query);
  const index = Math.min(selected, Math.max(0, filtered.length - 1));
  const close = () => { if (!pending) void dismiss(onClose); };

  useEffect(() => {
    search.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [dialog, index, query]);

  async function execute(action?: ConversationAction) {
    if (!action || action.disabledReason || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try { await onExecute(action); await dismiss(onClose); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试'); }
    finally { inFlight.current = false; setPending(false); }
  }

  return createPortal(<dialog ref={dialog} className="conversation-action-palette native-dialog-motion" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget && !pending) {
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    } }}
    onKeyDown={event => {
      onDialogKeyDown(event);
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (filtered.length) setSelected((index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length);
      } else if (event.key === 'Enter' && event.target === search.current) {
        event.preventDefault(); void execute(filtered[index]);
      }
    }}>
    <header><h2 id={titleId}>会话动作</h2><button type="button" className="icon-button" aria-label="关闭会话动作" disabled={pending} onClick={close}><X /></button></header>
    <div className="conversation-action-search"><Search aria-hidden="true" /><input ref={search} role="combobox" aria-label="搜索会话动作" aria-controls={listId} aria-expanded="true" aria-autocomplete="list" aria-activedescendant={filtered[index] ? `${listId}-${index}` : undefined} value={query} placeholder="搜索动作…" disabled={pending} onChange={event => { setQuery(event.target.value); setSelected(0); }} /></div>
    <div id={listId} role="listbox" aria-label="可用动作" className="conversation-action-results" aria-busy={pending}>
      {filtered.map((action, i) => <div key={action.id}>
        {(i === 0 || filtered[i - 1].group !== action.group) && <div className="conversation-action-group" role="presentation">{groups[action.group]}</div>}
        <button id={`${listId}-${i}`} type="button" role="option" tabIndex={-1} aria-selected={index === i} aria-disabled={Boolean(action.disabledReason) || pending} className="conversation-action-row" onMouseMove={() => setSelected(i)} onMouseDown={event => event.preventDefault()} onClick={() => void execute(action)}>
          <span><strong>{action.title}</strong><small>{action.disabledReason || action.description}</small></span>
          {pending && index === i ? <LoadingIndicator /> : action.id === 'temporary'
            ? <MessageCirclePlus aria-hidden="true" />
            : <ArrowUpRight aria-hidden="true" />}
        </button>
      </div>)}
      {!filtered.length && <p className="conversation-action-empty">没有匹配的动作</p>}
    </div>
    {error && <p className="conversation-action-error" role="alert">{error}</p>}
    <footer>
      {loading && !resourceError ? <LoadingState>正在加载扩展动作…</LoadingState> : <span>{resourceError || '↑ ↓ 选择 · Enter 执行'}</span>}
      <kbd>Esc 关闭</kbd>
    </footer>
  </dialog>, document.body);
}
