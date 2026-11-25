import { memo, useEffect, type ComponentProps } from 'react';
import { ComposerDock } from '../features/conversation/ComposerDock';
import { useConversationSearch } from '../features/conversation/useConversationSearch';
import { ConversationSearchBar } from './ConversationSearchBar';
import { ConversationTranscriptPane } from './ConversationTranscriptPane';
import type { useTranscriptNavigation } from '../features/conversation/useTranscriptNavigation';
import type { OutlineItem } from '../features/conversation/outline-model';
import type { Preferences } from '../shared/preferences';
import type { TurnDiff, TurnDiffFile } from '../types/chat-types';
import { ConversationHeader } from './ConversationHeader';

type SessionView = {
  id: string;
  cwd: string;
  title: string;
  turnDiffs?: TurnDiff[];
  longTask?: { updatedAt: number };
} | null;

type ConversationShell = {
  isNewConversation: boolean;
  sessionLoading: boolean;
  messageCount: number;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  session: SessionView;
  preferences: Preferences;
  turnActive: boolean;
  /** 提交已写入但本轮还没结束：编辑必须和主进程一样等到空闲。 */
  busy: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  compaction: { active: boolean; reason?: string };
  retryInfo: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  liveDiff: TurnDiff | null;
  conversationSubscriptionError: {
    sessionId: string;
    message: string;
    retrying: boolean;
  } | null;
  retryConversationSubscription: () => void;
  settingsOpen: boolean;
  visible: boolean;
};

type HeaderState = Omit<ComponentProps<typeof ConversationHeader>,
  'sidebarCollapsed' | 'onExpandSidebar' | 'isNewConversation' | 'title' | 'sessionId' | 'showTrace'>;

type OutlineState = {
  items: OutlineItem[];
  samples: ReturnType<typeof useTranscriptNavigation>['outlineSamples'];
  active: number;
  jump: (index: number) => void;
};

type ConversationActions = {
  openAttachment: (path: string) => void;
  openFile: (path: string) => void;
  undoTurnDiff: (at: number) => Promise<void>;
  openChanges: (file: TurnDiffFile | undefined, turn: TurnDiff) => void;
  openGit?: () => void;
  editMessage: (entryId: number, text: string) => Promise<void>;
};

export type ConversationWorkspaceProps = {
  shell: ConversationShell;
  header: HeaderState;
  actions: ConversationActions;
  transcript: ReturnType<typeof useTranscriptNavigation> & {
    /** 重新载入最新窗口（跳转截断后的回到底部）。 */
    resetToLatest: () => Promise<void>;
    /** 当前窗口是否缺少较新的一段。 */
    transcriptTruncated: boolean;
  };
  outline: OutlineState;
  composer: ComponentProps<typeof ComposerDock>;
};

function ConversationWorkspaceComponent({
  shell,
  header,
  actions,
  transcript,
  outline,
  composer,
}: ConversationWorkspaceProps) {
  const {
    isNewConversation,
    sessionLoading,
    messageCount,
    sidebarCollapsed,
    setSidebarCollapsed,
    session,
    preferences,
    turnActive,
    busy,
    error,
    setError,
    compaction,
    retryInfo,
    liveDiff,
    conversationSubscriptionError,
    retryConversationSubscription,
    settingsOpen,
    visible,
  } = shell;
  const {
    transcriptTurns,
    lastAssistantTurnIndex,
    jumpToMessage,
  } = transcript;

  const search = useConversationSearch({ sessionId: session?.id, onJump: jumpToMessage });
  const searchOpen = search.state.open;
  const searchEnabled = visible && Boolean(session?.id);

  useEffect(() => {
    if (!searchEnabled && searchOpen) search.close();
  }, [search.close, searchEnabled, searchOpen]);

  // ⌘F / Ctrl+F 打开对话搜索；焦点在终端里时让终端自己处理。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!searchEnabled) return;
      if (event.isComposing) return;
      const primary = event.metaKey || event.ctrlKey;
      if (!primary || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'f') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.terminal-host')) return;
      if (target?.closest?.('.file-panel')) return;
      event.preventDefault();
      if (searchOpen) { search.close(); return; }
      search.open();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [search, searchEnabled, searchOpen]);
  const lastAssistantTurn = transcriptTurns[lastAssistantTurnIndex];
  const lastAssistantError = lastAssistantTurn?.kind === 'assistant'
    ? lastAssistantTurn.messages.at(-1)?.errorMessage
    : undefined;
  const showSessionError = Boolean(error)
    && !(Boolean(error) && !turnActive && lastAssistantError === error);


  return (
    <>
      <ConversationHeader
        {...header}
        sidebarCollapsed={sidebarCollapsed}
        onExpandSidebar={() => setSidebarCollapsed(false)}
        isNewConversation={isNewConversation}
        title={session?.title || 'Pi Studio'}
        sessionId={session?.id}
        showTrace={preferences.showCodeView}
      />
      <main className={`main shell-canvas ${isNewConversation ? 'is-new-conversation' : ''}`} aria-busy={sessionLoading}>
        <div className={`chat-loading-line ${sessionLoading ? 'is-visible' : ''}`} />
      {searchEnabled && searchOpen && <ConversationSearchBar
        state={search.state}
        onQueryChange={search.setQuery}
        onStep={(direction) => { void search.step(direction); }}
        onClose={search.close}
      />}
      {!isNewConversation && <ConversationTranscriptPane
        sessionId={session?.id}
        sessionCwd={session?.cwd}
        messageCount={messageCount}
        turnActive={turnActive}
        busy={busy}
        compactionActive={compaction.active}
        error={error}
        setError={setError}
        retryInfo={retryInfo}
        liveDiff={liveDiff}
        turnDiffs={session?.turnDiffs}
        preferences={preferences}
        settingsOpen={settingsOpen}
        conversationSubscriptionError={conversationSubscriptionError}
        retryConversationSubscription={retryConversationSubscription}
        showSessionError={showSessionError}
        transcript={transcript}
        outline={outline}
        actions={actions}
      />}

      <ComposerDock {...composer} />
      </main>
    </>
  );
}

/** Prefer stable prop bags from App; shallow memo still skips pure chrome-only parent renders. */
export const ConversationWorkspace = memo(ConversationWorkspaceComponent);
