import { useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ModelSelection } from '../types/model-types';
import type { SessionStateForPersistence } from '../features/conversation/useMessageDelivery';
import {
  STORED_UI_KEYS,
  loadStoredModelComparisons,
  type StoredModelComparisonMap,
} from '../shared/stored-ui-state';
import type { AgentView, ModelComparisonContext } from './app-types';

type ConversationViewStateOptions = {
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  session: SessionStateForPersistence;
  workspace: string;
  agentView: AgentView;
  setAgentView: Dispatch<SetStateAction<AgentView>>;
  modelSelection: ModelSelection;
  filesOpen: boolean;
  closePanel: () => void;
  openComparisonTab: () => void;
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
  filesOpen,
  closePanel,
  openComparisonTab,
}: ConversationViewStateOptions) {
  const mainScrollPositionRef = useRef(0);
  const [comparisonByParent, setComparisonByParent] = useState<StoredModelComparisonMap>(
    loadStoredModelComparisons,
  );
  const comparisonStartPending = useRef(false);
  const [comparisonStarting, setComparisonStarting] = useState(false);
  const [comparisonPanelContext, setComparisonPanelContext] = useState<ModelComparisonContext | null>(null);

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

  function openModelComparison() {
    setComparisonPanelContext(current => current ?? {
      parentId: '',
      cwd: workspace,
      prompt: '',
      mentions: [],
      attachments: [],
      images: [],
      initialModelRef: modelSelection.modelRef,
      initialThinkingLevel: modelSelection.thinkingLevel,
    });
    openComparisonTab();
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

    comparisonStartPending,
    comparisonStarting,
    setComparisonStarting,
    comparisonPanelContext,
    setComparisonPanelContext,
    rememberMainScrollPosition,
    returnToMainAgent,
    openModelComparison,
    openTrace,
  };
}
