import type { ComposerEditorHandle } from '../features/conversation/ComposerEditor';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComposerAttachment } from '../types/chat-types';
import {
  composerDraftKeyForNew,
  type ComposerDraft,
  type ComposerDraftStore,
} from '../features/conversation/composer-drafts';
import {
  useComposerSuggestions,
  type ComposerMenuState,
} from '../features/conversation/useComposerSuggestions';

type ComposerInputStateOptions = {
  workspace: string;
  sessionId?: string;
};

export function useComposerInputState({
  workspace,
  sessionId,
}: ComposerInputStateOptions) {
  const [prompt, setPrompt] = useState('');
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [composerMenu, setComposerMenu] = useState<ComposerMenuState | null>(null);
  const [composerMenuIndex, setComposerMenuIndex] = useState(0);
  const [composerPersistenceReady, setComposerPersistenceReady] = useState(false);
  const [preparingDraftKeys, setPreparingDraftKeys] = useState<string[]>([]);
  const composerDraftKeyRef = useRef(composerDraftKeyForNew(''));
  const composerDraftsRef = useRef<ComposerDraftStore>(new Map());
  const composerPersistenceReadyRef = useRef(false);
  const composerPersistenceTimerRef = useRef<number | null>(null);
  const composerPersistenceWriteRef = useRef<Promise<void>>(Promise.resolve());
  const composerPersistenceErrorRef = useRef(false);
  const composerDeliveryRetriesRef = useRef(new Map<string, {
    draft: ComposerDraft;
    requestId: string;
  }>());
  const latestComposerAttemptByKeyRef = useRef(new Map<string, string>());
  const latestPromptBySessionRef = useRef(new Map<string, string>());
  const preparingDraftsRef = useRef(new Set<string>());
  const composerComposingRef = useRef(false);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const composerEditorRef = useRef<ComposerEditorHandle>(null);

  const composerImages = useMemo(
    () => composerAttachments.flatMap((attachment) => attachment.kind === 'image'
      ? [{ src: `data:${attachment.mime};base64,${attachment.data || ''}`, alt: attachment.name }]
      : []),
    [composerAttachments],
  );
  const composerImageIndexes = useMemo(() => {
    let imageIndex = 0;
    return new Map(composerAttachments.flatMap((attachment) => (
      attachment.kind === 'image' ? [[attachment.id, imageIndex++]] : []
    )));
  }, [composerAttachments]);
  const {
    commands: composerCommands,
    commandOptions: composerCommandOptions,
    mentions: composerMentionOptions,
    loading: composerMenuLoading,
    error: composerMenuError,
    retry: retryComposerSuggestions,
  } = useComposerSuggestions(composerMenu, workspace, sessionId);
  const preparing = preparingDraftKeys.includes(composerDraftKeyRef.current);

  const previousMcpServer = useRef<string | undefined>(undefined);
  useEffect(() => {
    const returningFrom = previousMcpServer.current;
    previousMcpServer.current = composerMenu?.mcpServer?.id;
    const index = returningFrom && composerMenu?.capabilityType === 'mcp' && !composerMenu.mcpServer
      ? composerMentionOptions.findIndex(item => item.type === 'mcp-server' && item.id === returningFrom)
      : 0;
    setComposerMenuIndex(Math.max(index, 0));
  }, [composerCommandOptions, composerMentionOptions, composerMenu?.kind, composerMenu?.query, composerMenu?.capabilityType, composerMenu?.mcpServer]);

  useEffect(() => {
    if (!composerMenu) return;
    composerWrapRef.current
      ?.querySelector<HTMLElement>('.composer-option.is-active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [composerMenu, composerMenuIndex]);

  useEffect(() => {
    if (!composerMenu) return;
    const onPointer = (event: PointerEvent) => {
      if (!composerWrapRef.current?.contains(event.target as Node)) setComposerMenu(null);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [composerMenu]);

  return {
    prompt,
    setPrompt,
    composerAttachments,
    setComposerAttachments,
    composerImages,
    composerImageIndexes,
    composerMenu,
    setComposerMenu,
    composerMenuIndex,
    setComposerMenuIndex,
    composerCommands,
    composerCommandOptions,
    composerMentionOptions,
    composerMenuLoading,
    composerMenuError,
    retryComposerSuggestions,
    composerDraftKeyRef,
    composerDraftsRef,
    composerPersistenceReady,
    setComposerPersistenceReady,
    composerPersistenceReadyRef,
    composerPersistenceTimerRef,
    composerPersistenceWriteRef,
    composerPersistenceErrorRef,
    composerDeliveryRetriesRef,
    latestComposerAttemptByKeyRef,
    latestPromptBySessionRef,
    preparingDraftsRef,
    preparingDraftKeys,
    setPreparingDraftKeys,
    preparing,
    composerComposingRef,
    composerWrapRef,
    composerEditorRef,
  };
}
