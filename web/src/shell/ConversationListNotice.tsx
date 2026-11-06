import './conversation-list-notice.css';

/** A committed mutation needs a read retry, never a second mutation. */
export function ConversationListNotice({ busy, onRefresh }: { busy: boolean; onRefresh: () => void }) {
  return <div className="conversation-list-notice" role="alert">
    <p>操作已完成，但会话列表刷新失败。</p>
    <button type="button" className="text-button" disabled={busy} onClick={onRefresh}>
      {busy ? '正在刷新…' : '刷新会话列表'}
    </button>
  </div>;
}
