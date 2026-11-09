import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { extractComposerMentions } from '../features/conversation/references';
import type { ComposerAttachment } from '../types/chat-types';
import type { ModelSelection } from '../types/model-types';
import type { SessionStateForPersistence } from '../features/conversation/useMessageDelivery';
import {
  STORED_UI_KEYS,
  loadStoredModelComparisons,
  type StoredModelComparison,
  type StoredModelComparisonMap,
} from '../shared/stored-ui-state';
import type { AgentView } from './app-types';

type ConversationViewStateOptions = {
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  session: SessionStateForPersistence;
  workspace: string;
  agentView: AgentView;
  setAgentView: Dispatch<SetStateAction<AgentView>>;
  modelSelection: ModelSelection;
  prompt: string;
  composerAttachments: ComposerAttachment[];
  filesOpen: boolean;
  closePanel: () => void;
};

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is optional; the in-memory view state remains usable.
  }
}

export function useConversationViewState({
  scrollRef,
  session,
  workspace,
  agentView,
  setAgentView,
  modelSelection,
  prompt,
  composerAttachments,
  filesOpen,
  closePanel,
}: ConversationViewStateOptions) {
  const mainScrollPositionRef = useRef(0);
  const [comparisonByParent, setComparisonByParent] = useState<StoredModelComparisonMap>(
    loadStoredModelComparisons,
  );
  const activeSessionComparison = useMemo(() => {
    const sessionId = session?.id;
    if (!sessionId) return null;
    if (comparisonByParent[sessionId]) return comparisonByParent[sessionId];
    return Object.values(comparisonByParent).find((entry) => (
      entry.result.branches.some((branch) => branch.sessionId === sessionId)
    )) ?? null;
  }, [comparisonByParent, session?.id]);

  useEffect(() => {
    writeStored(STORED_UI_KEYS.comparisons, comparisonByParent);
  }, [comparisonByParent]);

  function rememberMainScrollPosition() {
    if (agentView.kind === 'conversation') {
      mainScrollPositionRef.current = scrollRef.current?.scrollTop ?? mainScrollPositionRef.current;
    }
  }

  function returnToMainAgent() {
    if (agentView.kind === 'conversation') return;
    setAgentView({ kind: 'conversation' });
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = mainScrollPositionRef.current;
    });
  }

  function openStoredModelComparison(entry: StoredModelComparison) {
    rememberMainScrollPosition();
    setAgentView({
      kind: 'comparison',
      comparison: {
        parentId: entry.result.parentId,
        cwd: entry.cwd,
        prompt: entry.result.prompt,
        mentions: [],
        attachments: [],
        images: [],
        initialModelRef: entry.initialModelRef,
        initialThinkingLevel: entry.initialThinkingLevel,
      },
    });
    if (filesOpen) closePanel();
  }

  function openModelComparison() {
    if (!session?.id || !workspace) return;
    if (activeSessionComparison) {
      openStoredModelComparison(activeSessionComparison);
      return;
    }
    const images = composerAttachments.flatMap((attachment) => (
      attachment.kind === 'image' && attachment.data
        ? [{ type: 'image' as const, data: attachment.data, mimeType: attachment.mime }]
        : []
    ));
    const attachments = composerAttachments.flatMap((attachment) => (
      attachment.kind !== 'image' && attachment.path ? [attachment.path] : []
    ));
    rememberMainScrollPosition();
    setAgentView({
      kind: 'comparison',
      comparison: {
        parentId: session.id,
        cwd: session.cwd,
        prompt,
        mentions: extractComposerMentions(prompt),
        attachments,
        images,
        initialModelRef: modelSelection.modelRef,
        initialThinkingLevel: modelSelection.thinkingLevel,
      },
    });
    if (filesOpen) closePanel();
  }

  function openTrace() {
    if (!session?.id) return;
    rememberMainScrollPosition();
    setAgentView({ kind: 'trace' });
    if (filesOpen) closePanel();
  }

  return {
    comparisonByParent,
    setComparisonByParent,
    activeSessionComparison,
    rememberMainScrollPosition,
    returnToMainAgent,
    openModelComparison,
    openTrace,
  };
}
