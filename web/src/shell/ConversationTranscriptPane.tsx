import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';
import { JumpToLatestButton } from '../shared/JumpToLatestButton';
import { ChatMessageView } from '../features/conversation/ChatMessage';
import { AssistantTurnView } from '../features/conversation/AssistantTurn';
import { ConversationError } from '../features/conversation/ConversationError';
import { ConversationOutline } from '../features/conversation/ConversationOutline';
import { indexTurnDiffs } from '../features/conversation/file-changes';
import { NO_ANSWER_TEXT, type OutlineItem } from '../features/conversation/outline-model';
import type { useTranscriptNavigation } from '../features/conversation/useTranscriptNavigation';
import type { Preferences } from '../shared/preferences';
import type { TurnDiff, TurnDiffFile } from '../types/chat-types';
import {
  isNearBottom,
  nestedScrollableConsumesWheel,
  shouldReleaseFollowOnWheel,
} from '../features/conversation/chat-scroll.ts';

type TranscriptState = ReturnType<typeof useTranscriptNavigation> & {
  resetToLatest: () => Promise<void>;
  transcriptTruncated: boolean;
};

type Actions = {
  openAttachment: (path: string) => void;
  openFile: (path: string) => void;
  undoTurnDiff: (at: number) => Promise<void>;
  openChanges: (file: TurnDiffFile | undefined, turn: TurnDiff) => void;
  editMessage: (entryId: number, text: string) => Promise<void>;
};

type MessageListProps = {
  sessionId?: string;
  sessionCwd?: string;
  messageCount: number;
  turnActive: boolean;
  busy: boolean;
  compactionActive: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  retryInfo: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  liveDiff: TurnDiff | null;
  turnDiffs?: TurnDiff[];
  preferences: Preferences;
  conversationSubscriptionError: {
    sessionId: string;
    message: string;
    retrying: boolean;
  } | null;
  retryConversationSubscription: () => void;
  showSessionError: boolean;
  transcript: TranscriptState;
  actions: Actions;
  onNearBottomChange: (near: boolean) => void;
};

type TranscriptPaneProps = Omit<MessageListProps, 'onNearBottomChange'> & {
  settingsOpen: boolean;
  outline: {
    items: OutlineItem[];
    samples: TranscriptState['outlineSamples'];
    active: number;
    jump: (index: number) => void;
  };
};

function TranscriptMessageListComponent({
  sessionId,
  sessionCwd,
  messageCount,
  turnActive,
  busy,
  compactionActive,
  error,
  setError,
  retryInfo,
  liveDiff,
  turnDiffs,
  preferences,
  conversationSubscriptionError,
  retryConversationSubscription,
  showSessionError,
  transcript,
  actions,
  onNearBottomChange,
}: MessageListProps) {
  const {
    scrollRef,
    topSentinelRef,
    bottomSentinelRef,
    chatContentRef,
    turnWindowFrom,
    visibleTurns,
    toolResultMap,
    transcriptTurns,
    lastAssistantTurnIndex,
    nextUserTimestamps,
    requestPlacement,
    pendingAssistantVisible,
    pendingTurnError,
    markUserScrollIntent,
    pauseTranscriptFollow,
    resumeTranscriptFollow,
    handleTranscriptScroll,
  } = transcript;

  const turnDiffByIndex = useMemo(
    () => indexTurnDiffs(transcriptTurns, turnDiffs, nextUserTimestamps),
    [transcriptTurns, turnDiffs, nextUserTimestamps],
  );

  return (
    <div
      className="chat-scroll"
      ref={scrollRef}
      onWheel={(event) => {
        if (!event.deltaY) return;
        if (nestedScrollableConsumesWheel(event.target, event.currentTarget, event.deltaY)) return;
        markUserScrollIntent(event.deltaY);
        if (shouldReleaseFollowOnWheel({ deltaX: event.deltaX, deltaY: event.deltaY, nestedScrollable: false })) {
          pauseTranscriptFollow();
        } else if (event.deltaY > 0 && isNearBottom(event.currentTarget)) {
          resumeTranscriptFollow();
        }
      }}
      onTouchMove={() => {
        markUserScrollIntent();
        pauseTranscriptFollow();
      }}
      onPointerDown={() => {
        markUserScrollIntent();
        pauseTranscriptFollow();
      }}
      onPointerMove={(event) => {
        if (event.buttons !== 0) markUserScrollIntent();
      }}
      onKeyDown={(event) => {
        if (event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home') {
          markUserScrollIntent(-1);
          pauseTranscriptFollow();
        } else if (event.key === 'PageDown' || event.key === 'ArrowDown' || event.key === 'End') {
          markUserScrollIntent(1);
        }
      }}
      onScroll={(event) => {
        onNearBottomChange(isNearBottom(event.currentTarget));
        handleTranscriptScroll(event);
      }}
    >
      <div className="chat-column" ref={chatContentRef}>
        {messageCount > 0 && (
          <div className="messages">
            <div ref={topSentinelRef} className="transcript-window-sentinel" aria-hidden="true" />
            {visibleTurns.map((turn, offset) => {
              const index = offset + turnWindowFrom;
              if (turn.kind === 'user') {
                return <Fragment key={`user-${turn.message.sourceIndex ?? turn.message.timestamp ?? index}`}>
                  <ChatMessageView
                    id={`chat-turn-${turn.message.sourceIndex ?? `pending-${turn.message.timestamp ?? index}`}`}
                    message={turn.message}
                    onOpenFile={actions.openAttachment}
                    onEdit={actions.editMessage}
                    editDisabled={turnActive || busy || compactionActive}
                  />
                  {requestPlacement.unansweredByUserTurn.has(index) && <AssistantTurnView
                    messages={[]}
                    toolResults={toolResultMap}
                    requestTraces={requestPlacement.unansweredByUserTurn.get(index)}
                    cwd={sessionCwd}
                    busy={false}
                    turnError={NO_ANSWER_TEXT}
                    stepDisplay={preferences.stepDisplay}
                    stepCollapse={preferences.stepCollapse}
                    showCodeView={false}
                  />}
                </Fragment>;
              }
              return <AssistantTurnView
                key={`assistant-${turn.messages[0]?.sourceIndex ?? turn.messages[0]?.timestamp ?? index}`}
                id={turn.messages[0]?.sourceIndex !== undefined ? `chat-assistant-turn-${turn.messages[0].sourceIndex}` : undefined}
                messages={turn.messages}
                toolResults={toolResultMap}
                requestTraces={requestPlacement.byAssistantTurn.get(index)}
                cwd={sessionCwd}
                busy={turnActive && index === transcriptTurns.length - 1}
                retry={index === lastAssistantTurnIndex && retryInfo ? retryInfo : undefined}
                stepDisplay={preferences.stepDisplay}
                stepCollapse={preferences.stepCollapse}
                showCodeView={preferences.showCodeView}
                gitDiff={index === lastAssistantTurnIndex && liveDiff ? liveDiff : turnDiffByIndex.get(index)}
                onUndo={turnActive || busy ? undefined : actions.undoTurnDiff}
                onOpenDiff={actions.openChanges}
                onOpenFile={actions.openFile}
              />;
            })}
            {pendingAssistantVisible && (
              <AssistantTurnView
                key={`assistant-pending-${requestPlacement.pending[0]?.id || messageCount}`}
                messages={[]}
                toolResults={toolResultMap}
                requestTraces={requestPlacement.pending}
                cwd={sessionCwd}
                busy={turnActive}
                turnError={pendingTurnError}
                retry={turnActive ? retryInfo ?? undefined : undefined}
                stepDisplay={preferences.stepDisplay}
                stepCollapse={preferences.stepCollapse}
                showCodeView={false}
              />
            )}
            <div ref={bottomSentinelRef} className="transcript-window-sentinel" aria-hidden="true" />
          </div>
        )}
        {conversationSubscriptionError && conversationSubscriptionError.sessionId === sessionId && <ConversationError
          message={conversationSubscriptionError.message}
          actionLabel="重新连接"
          actionBusy={conversationSubscriptionError.retrying}
          onAction={retryConversationSubscription}
        />}
        {showSessionError && (!pendingAssistantVisible || turnActive) && <ConversationError message={error!} onDismiss={() => setError(null)} />}
      </div>
    </div>
  );
}

const TranscriptMessageList = memo(TranscriptMessageListComponent);

/**
 * Message list + outline. Isolated so typing in the composer does not rebuild
 * the whole transcript tree when parent bags stay referentially stable.
 * Outline hover stays local to ConversationOutline so it never rebuilds turns.
 */
function ConversationTranscriptPaneComponent({
  sessionId,
  sessionCwd,
  messageCount,
  turnActive,
  busy,
  compactionActive,
  error,
  setError,
  retryInfo,
  liveDiff,
  turnDiffs,
  preferences,
  settingsOpen,
  conversationSubscriptionError,
  retryConversationSubscription,
  showSessionError,
  transcript,
  outline,
  actions,
}: TranscriptPaneProps) {
  const [atBottom, setAtBottom] = useState(true);
  const [returningToLatest, setReturningToLatest] = useState(false);
  const {
    scrollRef,
    resumeTranscriptFollow,
    resetToLatest,
    transcriptTruncated,
  } = transcript;

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    setAtBottom(isNearBottom(viewport));
  }, [sessionId, scrollRef]);

  const onNearBottomChange = useCallback((near: boolean) => {
    setAtBottom(near);
  }, []);

  async function returnToLatest() {
    if (returningToLatest) return;
    if (!transcriptTruncated) {
      resumeTranscriptFollow(true);
      return;
    }
    setReturningToLatest(true);
    try { await resetToLatest(); }
    finally { setReturningToLatest(false); }
  }

  return (
    <div className="transcript-viewport">
      <TranscriptMessageList
        sessionId={sessionId}
        sessionCwd={sessionCwd}
        messageCount={messageCount}
        turnActive={turnActive}
        busy={busy}
        compactionActive={compactionActive}
        error={error}
        setError={setError}
        retryInfo={retryInfo}
        liveDiff={liveDiff}
        turnDiffs={turnDiffs}
        preferences={preferences}
        conversationSubscriptionError={conversationSubscriptionError}
        retryConversationSubscription={retryConversationSubscription}
        showSessionError={showSessionError}
        transcript={transcript}
        actions={actions}
        onNearBottomChange={onNearBottomChange}
      />
      {(transcriptTruncated || !atBottom) && (
        <JumpToLatestButton busy={returningToLatest} onClick={() => void returnToLatest()} />
      )}
      {!settingsOpen && outline.items.length > 1 && (
        <ConversationOutline
          items={outline.items}
          samples={outline.samples}
          activeIndex={outline.active}
          onJump={outline.jump}
        />
      )}
    </div>
  );
}

export const ConversationTranscriptPane = memo(ConversationTranscriptPaneComponent);
