import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ComposerCommand } from '../types/chat-types';
import type { PiSessionSummary, PiWorkspace } from './app-types';
import type { SidebarAction } from './SidebarActions';
import type { Preferences } from '../shared/preferences';
import {
  conversationActions,
  type ConversationAction,
} from '../features/conversation/conversation-actions';
import { matchesShortcut, normalizeShortcuts, isTextEntry } from '../shared/shortcuts.mjs';

type Setter<T> = Dispatch<SetStateAction<T>>;

type AppCommandPaletteDependencies = {
  preferences: Preferences;
  visibleWorkspaces: PiWorkspace[];
  session?: { id: string } | null;
  workspace: string;
  settingsOpen: boolean;
  filesOpen: boolean;
  turnActive: boolean;
  compactionActive: boolean;
  stateLoading: boolean;
  sessionLoading: boolean;
  messageCount: number;
  subagentCount: number;
  extensionCount: number;
  prompt: string;
  conversationNavigationRef: MutableRefObject<{
    open: (item: PiSessionSummary, reportError?: boolean) => Promise<boolean>;
    start: () => Promise<void>;
  }>;
  setComposerMenu: (value: null) => void;
  setSidebarCollapsed: Setter<boolean>;
  openSettings: () => Promise<void>;
  closePanel: () => void;
  openPanel: () => void;
  openBrowserTab: () => void;
  openTerminalTab: () => void;
  stopGeneration: () => Promise<void>;
  openModelComparison: () => void;
  returnToMainAgent: () => void;
  openAgentOverview: () => void;
  openConversationExtensionHub: () => void;
  openTemporaryChat: () => void;
  openFilesTab: () => void;
  sendPromptFromExtension: (prompt: string, submit: boolean) => void;
  executeExtensionCommand: (commandId: string, input?: string) => Promise<boolean>;
  sidebarAction: (
    kind: 'workspace' | 'session',
    id: string,
    action: SidebarAction,
    name?: string,
    options?: { preserveCurrentView?: boolean; notify?: boolean },
  ) => Promise<unknown>;
  openSettingsPage: (page: 'models' | 'mcp') => Promise<void>;
};

export function useAppCommandPalette({
  preferences,
  visibleWorkspaces,
  session,
  workspace,
  settingsOpen,
  filesOpen,
  turnActive,
  compactionActive,
  stateLoading,
  sessionLoading,
  messageCount,
  subagentCount,
  extensionCount,
  prompt,
  conversationNavigationRef,
  setComposerMenu,
  setSidebarCollapsed,
  openSettings,
  closePanel,
  openPanel,
  openBrowserTab,
  openTerminalTab,
  stopGeneration,
  openModelComparison,
  returnToMainAgent,
  openAgentOverview,
  openConversationExtensionHub,
  openTemporaryChat,
  openFilesTab,
  sendPromptFromExtension,
  executeExtensionCommand,
  sidebarAction,
  openSettingsPage,
}: AppCommandPaletteDependencies) {
  const [actionPaletteOpen, setActionPaletteOpen] = useState(false);
  const [actionCommands, setActionCommands] = useState<ComposerCommand[]>([]);
  const [actionResourcesLoading, setActionResourcesLoading] = useState(false);
  const [actionResourcesError, setActionResourcesError] = useState('');

  const shortcuts = useMemo<Record<string, string>>(
    () => normalizeShortcuts(preferences.shortcuts) as Record<string, string>,
    [preferences.shortcuts],
  );
  const shortcutSessions = useMemo(
    () => visibleWorkspaces.flatMap((item) => item.sessions),
    [visibleWorkspaces],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return;
      if (document.querySelector('dialog[open]')) return;
      if (settingsOpen && !matchesShortcut(event, shortcuts.settings)) return;
      const run = (id: string) => {
        event.preventDefault();
        setComposerMenu(null);
        switch (id) {
          case 'palette':
            setActionPaletteOpen(true);
            return;
          case 'settings':
            void openSettings();
            return;
          case 'toggleSidebar':
            setSidebarCollapsed((value) => !value);
            return;
          case 'togglePanel':
            if (filesOpen) closePanel(); else openPanel();
            return;
          case 'newChat':
            void conversationNavigationRef.current.start();
            return;
          case 'openBrowser':
            openBrowserTab();
            return;
          case 'openTerminal':
            openTerminalTab();
            return;
          case 'stopGeneration':
            if (turnActive) void stopGeneration();
            return;
          case 'nextSession':
          case 'prevSession': {
            const index = shortcutSessions.findIndex((entry) => entry.id === session?.id);
            const delta = id === 'nextSession' ? 1 : -1;
            const target = shortcutSessions[index < 0
              ? (delta > 0 ? 0 : shortcutSessions.length - 1)
              : (index + delta + shortcutSessions.length) % shortcutSessions.length];
            if (target) void conversationNavigationRef.current.open(target);
            return;
          }
          default:
        }
      };
      for (const id of Object.keys(shortcuts)) {
        if (matchesShortcut(event, shortcuts[id])) {
          // Bare typing never matches (bindings require a modifier), so only
          // text-entry shortcuts such as Mod+K need the guard.
          if (isTextEntry(event.target) && !event.metaKey && !event.ctrlKey) return;
          run(id);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcuts, settingsOpen, filesOpen, turnActive, shortcutSessions, session?.id]);

  useEffect(() => { setActionPaletteOpen(false); }, [session?.id, workspace, settingsOpen]);

  useEffect(() => {
    if (!actionPaletteOpen) return;
    let disposed = false;
    setActionCommands([]);
    setActionResourcesError('');
    setActionResourcesLoading(true);
    void window.piApi.composerResources({ sessionId: session?.id, cwd: workspace })
      .then(resources => { if (!disposed) setActionCommands(resources.commands); })
      .catch(() => { if (!disposed) setActionResourcesError('扩展动作暂时不可用，重新打开可重试'); })
      .finally(() => { if (!disposed) setActionResourcesLoading(false); });
    return () => { disposed = true; };
  }, [actionPaletteOpen, session?.id, workspace]);

  const availableConversationActions = conversationActions({
    sessionId: session?.id,
    workspace,
    running: turnActive || compactionActive,
    loading: stateLoading || sessionLoading,
    hasMessages: messageCount > 0,
    hasChildren: subagentCount > 0,
    hasExtensions: extensionCount > 0,
  }, actionCommands);

  async function executeConversationAction(action: ConversationAction) {
    const current = availableConversationActions.find(item => item.id === action.id);
    if (!current || current.disabledReason) {
      throw new Error(current?.disabledReason || '这个动作已不可用，请重新打开动作面板');
    }
    if (current.command) {
      if (current.command.argumentHint) {
        if (prompt.trim()) throw new Error('输入框里还有草稿，请先发送或清空，再填写扩展命令');
        sendPromptFromExtension(`/${current.command.name} `, false);
        return;
      }
      if (!await executeExtensionCommand(current.command.id, '')) {
        throw new Error('扩展动作未完成，请查看错误提示。');
      }
      return;
    }
    switch (current.id) {
      case 'fork': await sidebarAction('session', session!.id, 'fork'); break;
      case 'compare': openModelComparison(); break;
      case 'goal':
        returnToMainAgent();
        sendPromptFromExtension(prompt.trimStart().startsWith('/goal ') ? prompt : `/goal ${prompt}`, false);
        break;
      case 'subagents': openAgentOverview(); break;
      case 'extensions': openConversationExtensionHub(); break;
      case 'temporary': openTemporaryChat(); break;
      case 'files': openFilesTab(); openPanel(); break;
      case 'models': await openSettingsPage('models'); break;
      case 'mcp': await openSettingsPage('mcp'); break;
    }
  }

  return {
    actionPaletteOpen,
    setActionPaletteOpen,
    availableConversationActions,
    actionResourcesLoading,
    actionResourcesError,
    executeConversationAction,
  };
}
