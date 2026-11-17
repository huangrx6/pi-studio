import { memo } from 'react';
import { Markdown } from '../../shared/Markdown';
import { MarkdownImageRenderer } from '../../shared/markdown-actions';
import type { StepCollapse, StepDisplay } from '../../shared/preferences';
import type { ChatMessage, RequestTrace, TurnDiff, TurnDiffFile } from '../../types/chat-types';
import { ConversationError } from './ConversationError';
import { ConversationMarkdownImage } from './ConversationMarkdownImage';
import { ConversationImageGallery } from './ConversationImageGallery';
import { FileChangeSummary } from './FileChangeSummary';
import { collectFileChanges } from './file-changes';
import { formatTime } from './message-content';
import { MessageActions } from './MessageActions';
import { TurnActivity, ToolResultImages } from './TurnActivity';
import { buildTurnContent } from './turn-content';
import { WebSources } from './WebSources';
import './styles/execution-trace.css';

type AssistantTurnViewProps = {
  messages: ChatMessage[];
  toolResults: Map<string, ChatMessage>;
  requestTraces?: RequestTrace[];
  busy: boolean;
  id?: string;
  turnError?: string;
  retry?: { attempt: number; maxAttempts: number; errorMessage?: string };
  stepDisplay?: StepDisplay;
  stepCollapse?: StepCollapse;
  showCodeView?: boolean;
  cwd?: string;
  /** 本轮 Git 快照；比工具参数更完整，包含 bash/脚本产生的改动。 */
  gitDiff?: TurnDiff;
  onUndo?: (at: number) => Promise<void>;
  onOpenDiff?: (file: TurnDiffFile | undefined, turn: TurnDiff) => void;
  onOpenFile?: (path: string) => void;
};

function AssistantTurnViewComponent({ messages, toolResults, requestTraces = [], busy, id, turnError, retry, stepDisplay = 'standard', stepCollapse = 'after-answer', showCodeView = false, cwd, gitDiff, onUndo, onOpenDiff, onOpenFile }: AssistantTurnViewProps) {
  const live = Boolean(retry) || busy;
  // 只看本轮最后一条助手消息：压缩/重试产生的中间失败不应盖住后面的成功输出。
  const latest = messages.at(-1);
  const error = !live ? turnError || latest?.errorMessage : undefined;
  const interrupted = Boolean(error && /aborted/i.test(error));
  const failed = Boolean(error) && !interrupted;

  const { segments, answerText, activeTool, lastBlock, sources } = buildTurnContent(messages, toolResults, live);
  const phase = retry ? `正在重试 ${retry.attempt}/${retry.maxAttempts}`
    : activeTool ? '正在执行'
      : lastBlock?.type === 'thinking' ? '正在思考'
        : latest?.streaming && lastBlock?.type === 'text' ? '正在回复'
          : requestTraces.length > 0 ? '正在请求模型'
            : '正在继续处理';

  const codeFiles = showCodeView && !live ? collectFileChanges(messages, toolResults, cwd) : [];
  const turnDiff = showCodeView && !live ? gitDiff : undefined;

  return <div id={id} className={`assistant-turn ${live ? 'is-live' : ''} ${retry ? 'is-retrying' : ''} ${failed ? 'has-error' : ''} is-steps-${stepDisplay}`}>
    <div className="assistant-turn-rail"><span className="assistant-orb">π</span></div>
    <div className="assistant-turn-main">
      {/* 头部状态只在整轮结束后变为已完成，工具之间的等待仍是运行中。 */}
      <div className="assistant-turn-head">
        <span className="assistant-turn-name">Pi</span>
        <span className="assistant-turn-status" title={retry?.errorMessage}>{retry ? `重试中 ${retry.attempt}/${retry.maxAttempts}` : interrupted ? '已中断' : failed ? '失败' : live ? phase : '已完成'}</span>
        {latest?.timestamp && <time>{formatTime(latest.timestamp)}</time>}
      </div>

      {segments.map(segment => {
        if (segment.kind === 'activity') return <TurnActivity key={segment.key} entries={segment.entries}
          results={toolResults} live={live} active={segment === segments.at(-1) || segment.entries.some(entry => entry.live)}
          policy={stepCollapse} density={stepDisplay} onOpenFile={onOpenFile} />;
        if (segment.kind === 'tool-images') return <ToolResultImages key={segment.key} callId={segment.callId} images={segment.images} />;
        if (segment.kind === 'images') return <ConversationImageGallery key={segment.key} images={segment.images} />;
        return <div className="assistant-response" key={segment.key}><MarkdownImageRenderer.Provider value={ConversationMarkdownImage}>
          <Markdown>{segment.text}</Markdown>
        </MarkdownImageRenderer.Provider></div>;
      })}
      {sources.length > 0 && <WebSources sources={sources} />}
      {/* 失败卡片只在非 live 时出现，避免自动重试过程中闪错误。 */}
      {!live && error && (interrupted
        ? <div className="assistant-interrupted" role="status">本轮已中断</div>
        : <ConversationError className="assistant-error" message={error} announce={false} />)}
      {(codeFiles.length > 0 || (turnDiff?.files.length ?? 0) > 0) && <FileChangeSummary key={turnDiff?.at} onUndo={onUndo} files={codeFiles} gitDiff={turnDiff} onOpenDiff={onOpenDiff && ((file, turn) => onOpenDiff(file, { ...turn, at: turn.at || messages.at(-1)?.timestamp || 0 }))} onOpenFile={onOpenFile} />}
      {/* 回答结束后，悬浮显示复制与完成时间。 */}
      {!live && <MessageActions text={answerText} time={latest?.timestamp} label="复制回答" />}
    </div>
  </div>;
}

function sameMessageSequence(previous: ChatMessage[], next: ChatMessage[]): boolean {
  return previous.length === next.length && previous.every((message, index) => message === next[index]);
}

function sameRelevantToolResults(previous: Map<string, ChatMessage>, next: Map<string, ChatMessage>, messages: ChatMessage[]): boolean {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'toolCall' && previous.get(block.id) !== next.get(block.id)) return false;
    }
  }
  return true;
}

function sameAssistantTurnViewProps(previous: AssistantTurnViewProps, next: AssistantTurnViewProps): boolean {
  return previous.busy === next.busy
    && previous.id === next.id
    && previous.turnError === next.turnError
    && previous.stepDisplay === next.stepDisplay
    && previous.stepCollapse === next.stepCollapse
    && previous.showCodeView === next.showCodeView
    && previous.cwd === next.cwd
    && previous.onUndo === next.onUndo
    && previous.gitDiff === next.gitDiff
    && previous.onOpenDiff === next.onOpenDiff
    && previous.onOpenFile === next.onOpenFile
    && (previous.requestTraces === next.requestTraces
      || (previous.requestTraces?.length === next.requestTraces?.length
        && (previous.requestTraces || []).every((trace, index) => trace === next.requestTraces?.[index])))
    && (previous.retry === next.retry
      || (previous.retry?.attempt === next.retry?.attempt
        && previous.retry?.maxAttempts === next.retry?.maxAttempts
        && previous.retry?.errorMessage === next.retry?.errorMessage))
    && sameMessageSequence(previous.messages, next.messages)
    && sameRelevantToolResults(previous.toolResults, next.toolResults, previous.messages);
}

/** Completed turns stay mounted but skip work while only the streaming tail changes. */
export const AssistantTurnView = memo(AssistantTurnViewComponent, sameAssistantTurnViewProps);
