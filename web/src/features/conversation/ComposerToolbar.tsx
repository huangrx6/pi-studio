import type { ReactNode } from 'react';
import { ArrowUp, LoaderCircle, MoreHorizontal, Plus, Square } from 'lucide-react';
import './composer-toolbar.css';

/** Presentation only: request, attachment and queue ownership stays with the conversation. */
export function ComposerToolbar({
  context, model, isNewConversation, attachingDisabled, attachmentTitle,
  running, stopping, compacting, hasWorkspace, hasModel, isCommand, hasContent, loading, preparing = false,
  onAttach, onActions, onSend, onStop,
}: {
  context: ReactNode;
  model: ReactNode;
  isNewConversation: boolean;
  attachingDisabled: boolean;
  attachmentTitle: string;
  running: boolean;
  stopping: boolean;
  compacting: boolean;
  hasWorkspace: boolean;
  hasModel: boolean;
  isCommand: boolean;
  hasContent: boolean;
  loading: boolean;
  preparing?: boolean;
  onAttach: () => void;
  onActions: () => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const sendTitle = preparing ? '正在准备消息，草稿仍可编辑' : loading ? '正在加载会话'
    : !isCommand && !hasWorkspace ? '请先选择工作区'
      : !isCommand && !hasModel ? '请先选择可用模型'
      : compacting ? '正在压缩上下文，完成后自动继续'
        : running ? '补充当前任务；Cmd/Ctrl+Enter 排队' : '发送消息';
  return <div className="composer-bar composer-toolbar">
    <div className={`composer-left ${isNewConversation ? 'is-new-conversation' : ''}`}>
      <button type="button" className="composer-attach-button" disabled={attachingDisabled} onClick={onAttach} aria-label="添加图片或文件" title={attachmentTitle}><Plus aria-hidden="true" /></button>
      <div className="composer-context-group">{context}</div>
    </div>
    <div className="composer-right">
      <button type="button" className="composer-more-button" aria-label="更多会话动作" title="会话动作 · ⌘K / Ctrl+K" onClick={onActions}><MoreHorizontal aria-hidden="true" /></button>
      {model}
      {running && <button type="button" className="send-button is-stop" disabled={stopping} onClick={onStop} aria-label={stopping ? '正在停止当前任务' : '停止当前任务'} title={stopping ? '正在停止当前任务' : '停止当前任务'}>{stopping ? <LoaderCircle className="spin" aria-hidden="true" /> : <Square fill="currentColor" aria-hidden="true" />}</button>}
      {(!running || hasContent) && <button type="button" className="send-button" disabled={preparing || loading || stopping || (!isCommand && (!hasWorkspace || !hasModel)) || !hasContent || compacting} onClick={onSend} aria-label={preparing ? '正在准备消息' : compacting ? '正在压缩上下文' : running ? '补充当前任务' : '发送消息'} title={sendTitle}>{preparing ? <LoaderCircle className="spin" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}</button>}
    </div>
  </div>;
}
