import type { ReactNode } from 'react';
import { ArrowUp, ListPlus, Plus, Square } from 'lucide-react';
import { LoadingIndicator } from '../../shared/LoadingState';
import { formatShortcut } from '../../shared/shortcuts';
import { resolveComposerPrimaryAction } from './composer-primary-action';
import './styles/composer-toolbar.css';

export { resolveComposerPrimaryAction } from './composer-primary-action';
export type { ComposerPrimaryAction } from './composer-primary-action';

/** Presentation only: request, attachment and queue ownership stays with the conversation. */
export function ComposerToolbar({
  context, model, isNewConversation, attachingDisabled, attachmentTitle,
  running, stopping, compacting, hasWorkspace, hasModel, isCommand, hasContent, loading, preparing = false,
  onAttach, onSend, onStop, onQueue,
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
  onSend: () => void;
  onStop: () => void;
  onQueue: () => void;
}) {
  const primary = resolveComposerPrimaryAction({ running, stopping, preparing, hasContent });
  const canDispatch = !loading && !stopping && !preparing && !compacting
    && (isCommand || (hasWorkspace && hasModel));
  const sendDisabled = !canDispatch || !hasContent;
  const queueTitle = `排队下一条 · ${formatShortcut('Mod+Enter')}`;
  const sendTitle = preparing ? '正在准备消息，草稿仍可编辑'
    : stopping ? '正在停止当前任务'
      : loading ? '正在加载会话'
        : !isCommand && !hasWorkspace ? '请先选择工作区'
          : !isCommand && !hasModel ? '请先选择可用模型'
            : compacting ? '正在压缩我们的对话内容，以便继续对话'
              : '发送消息';
  const stopTitle = stopping ? '正在停止当前任务' : '停止当前任务';

  return <div className="composer-bar composer-toolbar">
    <div className={`composer-left ${isNewConversation ? 'is-new-conversation' : ''}`}>
      <button type="button" className="composer-attach-button" disabled={attachingDisabled} onClick={onAttach} aria-label="添加图片或文件" title={attachmentTitle}><Plus aria-hidden="true" /></button>
      <div className="composer-context-group">{context}</div>
    </div>
    <div className="composer-right">
      {model}
      {primary === 'stop' || primary === 'stopping' ? (
        <button
          type="button"
          className="send-button is-stop"
          disabled={primary === 'stopping'}
          onClick={onStop}
          aria-label={stopTitle}
          title={stopTitle}
        >
          {primary === 'stopping' ? <LoadingIndicator /> : <Square fill="currentColor" aria-hidden="true" />}
        </button>
      ) : primary === 'queue' ? (
        <button
          type="button"
          className="send-button is-queue"
          disabled={!canDispatch || !hasContent}
          onClick={onQueue}
          aria-label="排队下一条"
          title={queueTitle}
        >
          <ListPlus aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          className="send-button"
          onClick={onSend}
          title={sendTitle}
          disabled={sendDisabled}
          aria-label={preparing ? '正在准备消息' : compacting ? '正在压缩对话内容' : '发送消息'}
        >
          {primary === 'preparing' ? <LoadingIndicator /> : <ArrowUp aria-hidden="true" />}
        </button>
      )}
    </div>
  </div>;
}
