/**
 * 对话内搜索条。
 *
 * 结果来自主进程对整段历史的扫描，所以条数包含还没加载进窗口的消息。
 * 每次跳转都由 `onJump` 负责补页与滚动，这里只负责输入与上下步进。
 */
import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from 'lucide-react';
import type { ConversationSearchState } from '../features/conversation/useConversationSearch';

export function ConversationSearchBar({
  state,
  onQueryChange,
  onStep,
  onClose,
}: {
  state: ConversationSearchState;
  onQueryChange: (query: string) => void;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const position = state.items.length === 0
    ? (state.query.trim().length >= 2 && !state.loading ? '无结果' : '')
    : `${state.index + 1}/${state.items.length}`;

  return <div className="conversation-search" role="search">
    <Search aria-hidden="true" />
    <input
      ref={inputRef}
      value={state.query}
      placeholder="搜索这条对话的全部内容"
      aria-label="搜索这条对话的全部内容"
      onChange={(event) => onQueryChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
        if (event.key === 'Enter') {
          event.preventDefault();
          onStep(event.shiftKey ? -1 : 1);
        }
      }}
    />
    <span className="conversation-search-count" aria-live="polite">
      {state.loading ? <LoaderCircle className="spin" aria-hidden="true" /> : position}
    </span>
    <button type="button" aria-label="上一个结果" title="上一个 ⇧Enter" onClick={() => onStep(-1)}><ChevronUp /></button>
    <button type="button" aria-label="下一个结果" title="下一个 Enter" onClick={() => onStep(1)}><ChevronDown /></button>
    <button type="button" aria-label="关闭搜索" title="关闭 Esc" onClick={onClose}><X /></button>
    {state.error && <div className="conversation-search-error" role="alert">{state.error}</div>}
  </div>;
}
