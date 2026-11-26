import { memo, useContext, useMemo, useRef } from 'react';
import { Markdown } from '../../shared/Markdown';
import { MarkdownActions, MarkdownImageRenderer } from '../../shared/markdown-actions';
import type { StepCollapse, StepDisplay } from '../../shared/preferences';
import type { ChatMessage, RequestTrace, TurnDiff, TurnDiffFile } from '../../types/chat-types';
import { ConversationError } from './ConversationError';
import { ConversationMarkdownImage } from './ConversationMarkdownImage';
import { ConversationImageGallery } from './ConversationImageGallery';
import { FileChangeSummary } from './FileChangeSummary';
import { collectFileChanges, sameChangePath, toolFilePatch } from './file-changes';
import { formatTime } from './message-content';
import { MessageActions } from './MessageActions';
import { NarrativeLiveStatus, NarrativeWorkstream } from './NarrativeWorkstream';
import {
  buildNarrativeBlocks,
  collectTurnFilePaths,
  computeTurnTiming,
  formatTurnDuration,
  resolveTurnFilePath,
} from './narrative-stream-model.ts';
import { buildTurnContent, type BuiltTurnContent } from './turn-content';
import { WebSources } from './WebSources';
import './styles/execution-trace.css';

type AssistantTurnViewProps = {
  messages: ChatMessage[];
  toolResults: Map<string, ChatMessage>;
  requestTraces?: RequestTrace[];
  startedAt?: number;
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
  onOpenGit?: () => void;
  onOpenFile?: (path: string) => void;
};

function AssistantTurnViewComponent({
  messages,
  toolResults,
  requestTraces = [],
  startedAt,
  busy,
  id,
  turnError,
  retry,
  stepDisplay = 'standard',
  stepCollapse = 'after-answer',
  showCodeView = false,
  cwd,
  gitDiff,
  onUndo,
  onOpenDiff,
  onOpenGit,
  onOpenFile,
}: AssistantTurnViewProps) {
  const live = Boolean(retry) || busy;
  // 只看本轮最后一条助手消息：压缩/重试产生的中间失败不应盖住后面的成功输出。
  const latest = messages.at(-1);
  const error = !live ? turnError || latest?.errorMessage : undefined;
  const interrupted = Boolean(error && /aborted/i.test(error));
  const failed = Boolean(error) && !interrupted;

  const builtRef = useRef<BuiltTurnContent | null>(null);
  const built = buildTurnContent(messages, toolResults, live, builtRef.current);
  builtRef.current = built;
  const { segments, answerText, sources } = built;

  const blocks = useMemo(() => buildNarrativeBlocks(segments), [segments]);
  const parentMarkdownActions = useContext(MarkdownActions);
  const turnFilePaths = useMemo(() => collectTurnFilePaths(messages, gitDiff), [gitDiff, messages]);
  const turnMarkdownActions = useMemo(() => ({
    ...parentMarkdownActions,
    cwd: cwd || parentMarkdownActions.cwd,
    openFile: onOpenFile || parentMarkdownActions.openFile,
    resolvePath: (token: string) => (
      resolveTurnFilePath(token, turnFilePaths, cwd || parentMarkdownActions.cwd)
      ?? parentMarkdownActions.resolvePath?.(token)
    ),
  }), [cwd, onOpenFile, parentMarkdownActions, turnFilePaths]);
  const codeFiles = showCodeView && !live ? collectFileChanges(messages, toolResults, cwd) : [];
  const turnDiff = showCodeView && !live ? gitDiff : undefined;

  function handleOpenChangeDiff(filePath?: string) {
    if (onOpenDiff) {
      const turnAt = gitDiff?.at || messages.at(-1)?.timestamp || 0;
      const toolChanges = collectFileChanges(messages, toolResults, cwd);
      const files: TurnDiffFile[] = [...(gitDiff?.files ?? [])];
      for (const change of toolChanges) {
        if (files.some((item) => sameChangePath(item, change))) continue;
        const patch = toolFilePatch(change);
        files.push({
          path: change.path,
          label: change.label,
          status: change.removed === 0 && /\/dev\/null/.test(patch || '') ? 'added' : 'modified',
          added: change.added,
          removed: change.removed,
          completeCounts: change.completeCounts,
          patch,
        });
      }
      if (files.length > 0) {
        const matched = filePath
          ? files.find((item) => sameChangePath(item, { path: filePath, label: filePath }))
          : undefined;
        const review: TurnDiff = {
          ...gitDiff,
          at: turnAt,
          totalAdded: files.reduce((sum, item) => sum + item.added, 0),
          totalRemoved: files.reduce((sum, item) => sum + item.removed, 0),
          files,
        };
        onOpenDiff(matched, review);
        return;
      }
    }
    onOpenGit?.();
  }

  const { startMs, endMs } = useMemo(
    () => computeTurnTiming(messages, toolResults, requestTraces, startedAt),
    [messages, requestTraces, startedAt, toolResults],
  );
  const durationLabel = startMs !== undefined && endMs !== undefined ? formatTurnDuration(endMs - startMs) : '';
  const headerTimeLabel = !live ? durationLabel || (latest?.timestamp ? formatTime(latest.timestamp) : '') : '';
  const headerTimeTitle = endMs
    ? new Date(endMs).toLocaleString('zh-CN')
    : latest?.timestamp
      ? new Date(latest.timestamp).toLocaleString('zh-CN')
      : undefined;

  return <div id={id} className={`assistant-turn ${live ? 'is-live' : ''} ${retry ? 'is-retrying' : ''} ${failed ? 'has-error' : ''} is-steps-${stepDisplay}`}>
    <div className="assistant-turn-rail" aria-hidden="true"><span className="assistant-orb"><span className="pi-mark" /></span></div>
    <div className="assistant-turn-main">
      <div className="assistant-turn-head">
        <span className="assistant-turn-name">Pi</span>
        {headerTimeLabel && <time title={headerTimeTitle}>{headerTimeLabel}</time>}
      </div>

      <MarkdownActions.Provider value={turnMarkdownActions}>
      <MarkdownImageRenderer.Provider value={ConversationMarkdownImage}>
        {blocks.map((block, index) => {
          const isTail = index === blocks.length - 1;
          const prevWasWork = index > 0 && blocks[index - 1].kind === 'work';
          if (block.kind === 'work') {
            return (
              <NarrativeWorkstream
                key={block.key}
                entries={block.entries}
                results={toolResults}
                toolImages={block.toolImages}
                cwd={cwd}
                live={live && (isTail || block.entries.some((entry) => entry.live))}
                density={stepDisplay}
                policy={stepCollapse}
                onOpenFile={onOpenFile}
                onOpenChangeDiff={onOpenDiff || onOpenGit ? handleOpenChangeDiff : undefined}
              />
            );
          }
          if (block.kind === 'images') {
            return <ConversationImageGallery key={block.key} images={block.images} />;
          }
          return (
            <div className={`assistant-response${prevWasWork ? ' has-preceding-activity' : ''}`} key={block.key}>
              <Markdown streaming={live && isTail}>{block.text}</Markdown>
            </div>
          );
        })}
      </MarkdownImageRenderer.Provider>
      </MarkdownActions.Provider>

      {/* 失败卡片只在非 live 时出现，避免自动重试过程中闪错误。 */}
      {!live && error && (interrupted
        ? <div className="assistant-interrupted" role="status">本轮已中断</div>
        : <ConversationError className="assistant-error" message={error} announce={false} />)}
      {(codeFiles.length > 0 || (turnDiff?.files.length ?? 0) > 0) && (
        <FileChangeSummary
          key={turnDiff?.at}
          onUndo={onUndo}
          files={codeFiles}
          gitDiff={turnDiff}
          onOpenDiff={onOpenDiff && ((file, turn) => onOpenDiff(file, { ...turn, at: turn.at || messages.at(-1)?.timestamp || 0 }))}
          onOpenFile={onOpenFile}
        />
      )}
      <MessageActions text={live ? '' : answerText} time={live ? undefined : latest?.timestamp} label="复制回答">
        {sources.length > 0 && <WebSources sources={sources} />}
      </MessageActions>
      {live && <NarrativeLiveStatus startedAt={startMs} retry={retry} />}
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
    && previous.startedAt === next.startedAt
    && previous.turnError === next.turnError
    && previous.stepDisplay === next.stepDisplay
    && previous.stepCollapse === next.stepCollapse
    && previous.showCodeView === next.showCodeView
    && previous.cwd === next.cwd
    && previous.onUndo === next.onUndo
    && previous.gitDiff === next.gitDiff
    && previous.onOpenDiff === next.onOpenDiff
    && previous.onOpenGit === next.onOpenGit
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
