import type { ComposerEditorHandle } from './ComposerEditor';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ChatMessage } from '../../types/chat-types';
import type {
  ModelSelection,
  ThinkingLevel,
} from '../../types/model-types';
import { thinkingLabels } from '../../types/model-types';
import type {
  LongTaskState,
} from '../../types/durable-types';
import type {
  ExtensionCommandResult,
  ExtensionUiAction,
} from '../../types/extension-types';
import type { ModelPickerRequest } from '../models/ModelPicker';
import type { ComposerMenuState } from './useComposerSuggestions';
import { composerCapabilityCategories, composerMenuAt } from './composer-menu';
import type { ComposerCommand, ComposerMentionOption } from '../../types/chat-types';
import type { ComposerDraft } from './composer-drafts';
import {
  composerDraftMatches,
  snapshotComposerDraft,
} from './composer-preparation';
import {
  clearComposerDraft,
  readComposerDraft,
  saveComposerDraft,
} from './composer-drafts';
import {
  formatAgentReference,
  formatCapabilityReference,
  formatFileReference,
  insertComposerToken,
} from './references';
import { textOfBlocks } from './outline-model';
import {
  normalizeThinkingLevelArgument,
  parseGoalCommandArgument,
  parseStudioCommand,
} from './composer-command-routes.ts';
import { errorText } from '../../shared/error-text';
import type { SettingsTab } from '../../shell/app-shell-config';

type Setter<T> = Dispatch<SetStateAction<T>>;
type SessionState = {
  id: string;
  cwd: string;
  title: string;
  longTask?: LongTaskState;
} | null;

type ComposerCommandsDependencies = {
  session: SessionState;
  sessionRef: MutableRefObject<SessionState>;
  sessionLoadRef: MutableRefObject<number>;
  workspace: string;
  modelSelection: ModelSelection;
  busy: boolean;
  stateLoading: boolean;
  sessionLoading: boolean;
  isNewConversation: boolean;
  messages: ChatMessage[];
  prompt: string;
  composerAttachments: import('../../types/chat-types').ComposerAttachment[];
  composerDraftKeyRef: MutableRefObject<string>;
  composerDraftsRef: MutableRefObject<Map<string, ComposerDraft>>;
  composerMenu: ComposerMenuState | null;
  composerMentionOptions: ComposerMentionOption[];
  composerCommandOptions: ComposerCommand[];
  composerCommands: ComposerCommand[];
  composerEditorRef: MutableRefObject<ComposerEditorHandle | null>;
  modelPickerRequestRef: MutableRefObject<number>;
  conversationNavigationRef: MutableRefObject<{
    open: (item: import('../../shell/app-types').PiSessionSummary) => Promise<boolean>;
    start: (cwd: string) => Promise<void>;
  }>;
  setBusy: Setter<boolean>;
  setError: Setter<string | null>;
  setLongTaskBusy: Setter<boolean>;
  setComposerMenu: Setter<ComposerMenuState | null>;
  setComposerMenuIndex: Setter<number>;
  setModelPickerRequest: Setter<ModelPickerRequest | null>;
  setPrompt: Setter<string>;
  currentComposerDraft: () => ComposerDraft;
  clearActiveComposerDraftText: () => void;
  clearActiveComposerDraft: () => void;
  send: (text?: string, busyBehavior?: 'steer' | 'queue') => Promise<void>;
  executeLongTaskAction: (
    action:
      | 'long-task-set'
      | 'long-task-edit'
      | 'long-task-complete'
      | 'long-task-clear'
      | 'long-task-pause'
      | 'long-task-resume',
    payload?: { goal?: string; completionCriteria?: string; summary?: string },
  ) => Promise<void>;
  startSession: (
    cwd?: string,
    options?: { restoreDraft?: boolean; checkpoint?: boolean },
  ) => Promise<void>;
  openSettings: (page?: SettingsTab) => Promise<void>;
  selectModel: (id: string) => Promise<void>;
  selectThinking: (level: ThinkingLevel) => Promise<void>;
  loadState: () => Promise<void>;
  showComposerFeedback: (message: string, tone?: 'info' | 'warning') => void;
  openExtensionPanel: (panelId: string) => Promise<void>;
};

export function useComposerCommands({
  session,
  sessionRef,
  sessionLoadRef,
  workspace,
  modelSelection,
  busy,
  stateLoading,
  sessionLoading,
  isNewConversation,
  messages,
  prompt,
  composerAttachments,
  composerDraftKeyRef,
  composerDraftsRef,
  composerMenu,
  composerMentionOptions,
  composerCommandOptions,
  composerEditorRef,
  modelPickerRequestRef,
  conversationNavigationRef,
  setBusy,
  setError,
  setLongTaskBusy,
  setComposerMenu,
  setComposerMenuIndex,
  setModelPickerRequest,
  setPrompt,
  currentComposerDraft,
  clearActiveComposerDraftText,
  clearActiveComposerDraft,
  send,
  executeLongTaskAction,
  startSession,
  openSettings,
  selectModel,
  selectThinking,
  loadState,
  showComposerFeedback,
  openExtensionPanel,
}: ComposerCommandsDependencies) {
  function updateComposerMenu(value: string, caret: number) {
    setComposerMenu(current => composerMenuAt(value, caret, current));
    setComposerMenuIndex(0);
  }

  function requestModelPicker(view: ModelPickerRequest['view']) {
    modelPickerRequestRef.current += 1;
    setModelPickerRequest({ id: modelPickerRequestRef.current, view });
  }

  function sendPromptFromExtension(text: string, submit: boolean) {
    const ownerKey = composerDraftKeyRef.current;
    const generation = sessionLoadRef.current;
    saveComposerDraft(composerDraftsRef.current, ownerKey, {
      ...readComposerDraft(composerDraftsRef.current, ownerKey), text,
    });
    setPrompt(text);
    setComposerMenu(null);
    if (submit) {
      void send(text);
      return;
    }
    requestAnimationFrame(() => {
      if (sessionLoadRef.current !== generation || composerDraftKeyRef.current !== ownerKey
        || readComposerDraft(composerDraftsRef.current, ownerKey).text !== text) return;
      const node = composerEditorRef.current;
      node?.focus();
      node?.setSelectionRange(text.length, text.length);
    });
  }

  async function applyExtensionAction(action: ExtensionUiAction, depth = 0): Promise<void> {
    if (depth > 4) throw new Error('扩展动作调用了过多层级');
    if (action.kind === 'openSettings') {
      await openSettings(action.panel);
      return;
    }
    if (action.kind === 'openPanel') {
      await openExtensionPanel(action.panelId);
      return;
    }
    if (action.kind === 'sendPrompt') {
      sendPromptFromExtension(action.text, Boolean(action.submit));
      return;
    }
    if (action.kind === 'copyText') {
      await navigator.clipboard.writeText(action.text);
      return;
    }
    if (action.kind === 'openUrl') {
      await window.piApi.openExternal(action.url);
      return;
    }
    await executeExtensionCommand(action.commandId, '', depth + 1);
  }

  async function applyExtensionCommandResult(
    result: ExtensionCommandResult,
    depth = 0,
    canApply: () => boolean = () => true,
    acceptOwnDraftChange: (submitted?: boolean) => void = () => {},
  ): Promise<boolean> {
    if (!canApply()) return false;
    if (result.action) {
      if (depth > 4) throw new Error('扩展动作调用了过多层级');
      if (result.action.kind === 'sendPrompt') {
        sendPromptFromExtension(result.action.text, Boolean(result.action.submit));
        acceptOwnDraftChange(Boolean(result.action.submit));
      } else {
        if (result.action.kind === 'runCommand') {
          await executeExtensionCommand(result.action.commandId, '', depth + 1, acceptOwnDraftChange);
        } else await applyExtensionAction(result.action, depth);
        if (!canApply()) return false;
      }
    }
    if (result.promptText) {
      sendPromptFromExtension(result.promptText, Boolean(result.submit));
      acceptOwnDraftChange(Boolean(result.submit));
    }
    if (result.settingsPage) {
      await openSettings(result.settingsPage as SettingsTab);
      if (!canApply()) return false;
    }
    if (result.panelId) {
      await openExtensionPanel(result.panelId);
      if (!canApply()) return false;
    }
    if (result.message) {
      setError(null);
      showComposerFeedback(result.message, 'info');
    }
    return true;
  }

  async function executeExtensionCommand(
    commandId: string,
    input = '',
    depth = 0,
    onOwnedDraftChange?: (submitted?: boolean) => void,
  ): Promise<boolean> {
    const ownerKey = composerDraftKeyRef.current;
    const generation = sessionLoadRef.current;
    let expected = snapshotComposerDraft(readComposerDraft(composerDraftsRef.current, ownerKey));
    const sourceId = sessionRef.current?.id;
    const sourceLabel = sessionRef.current?.title || workspace || '新对话';
    const sameContext = () => sessionLoadRef.current === generation && composerDraftKeyRef.current === ownerKey;
    let ownSubmissionPending = false;
    const canApply = () => {
      if (!sameContext()) return false;
      const current = readComposerDraft(composerDraftsRef.current, ownerKey);
      return composerDraftMatches(current, expected)
        || (ownSubmissionPending && !current.text && current.attachments.length === 0);
    };
    const acceptOwnDraftChange = (submitted = false) => {
      if (!sameContext()) return;
      expected = snapshotComposerDraft(readComposerDraft(composerDraftsRef.current, ownerKey));
      ownSubmissionPending = submitted;
      onOwnedDraftChange?.(submitted);
    };
    try {
      const result = await window.piApi.runExtensionCommand({ commandId, sessionId: sourceId, cwd: workspace, input });
      const applied = await applyExtensionCommandResult(result, depth + 1, canApply, acceptOwnDraftChange);
      if (!applied && sameContext()) {
        showComposerFeedback(
          `扩展命令「${commandId}」已在 ${sourceLabel} 执行；输入或会话已变化，后续结果未替换当前输入。`,
          'info',
        );
      }
      return true;
    } catch (cause) {
      if (canApply()) setError(errorText(cause));
      return false;
    }
  }

  async function findExtensionCommand(input: string): Promise<{ commandId: string; argument: string } | undefined> {
    const match = input.match(/^\/([a-z0-9._-]+)(?:\s+([\s\S]*))?$/i);
    if (!match) return undefined;
    try {
      const resources = await window.piApi.composerResources({ sessionId: session?.id, cwd: workspace });
      const command = resources.commands.find((item) => item.source === 'extension' && item.name === match[1]);
      return command?.commandId ? { commandId: command.commandId, argument: match[2] || '' } : undefined;
    } catch {
      return undefined;
    }
  }

  async function executeBuiltinCommand(input: string): Promise<boolean> {
    const command = parseStudioCommand(input);
    if (!command) return false;
    if (command.route === 'session.new') {
      if (busy) {
        clearActiveComposerDraftText();
        return true;
      }
      clearActiveComposerDraft();
      await startSession(undefined, {
        restoreDraft: false,
        checkpoint: false,
      });
      return true;
    }
    if (command.route === 'settings.open') { await openSettings(); return true; }
    if (command.route === 'settings.mcp') { await openSettings('mcp'); return true; }
    if (command.route === 'model.picker') {
      if (stateLoading || sessionLoading) return true;
      if (command.argument) {
        try { await selectModel(command.argument); }
        catch (error) { showComposerFeedback(errorText(error)); }
      } else if (isNewConversation && (!modelSelection.modelRef || modelSelection.unavailable)) {
        await openSettings('models');
      } else {
        requestModelPicker('models');
      }
      return true;
    }
    if (command.route === 'thinking.picker') {
      if (!session) return true;
      if (busy || stateLoading || sessionLoading) return true;
      if (!command.argument) {
        requestModelPicker('thinking');
        return true;
      }
      const normalized = normalizeThinkingLevelArgument(command.argument);
      const level = normalized as ThinkingLevel | null;
      if (!level || !modelSelection.thinkingLevels.includes(level)) {
        const available = modelSelection.thinkingLevels.map((item) => thinkingLabels[item]).join('、');
        showComposerFeedback(`当前模型可用等级：${available || 'Default'}`, 'info');
        return true;
      }
      try { await selectThinking(level); }
      catch (error) { showComposerFeedback(errorText(error)); }
      return true;
    }
    if (command.route === 'goal.control') {
      const currentSession = sessionRef.current;
      const goalCommand = parseGoalCommandArgument(command.argument);
      if (!currentSession?.id && goalCommand.action === 'set') {
        if (!goalCommand.text) {
          showComposerFeedback('/goal 后需要填写目标。');
          return true;
        }
        if (!workspace) {
          showComposerFeedback('请先选择一个工作区，再设置长期目标。');
          return true;
        }
        const ownerKey = composerDraftKeyRef.current;
        const generation = sessionLoadRef.current;
        const original = snapshotComposerDraft(readComposerDraft(composerDraftsRef.current, ownerKey));
        const canApply = () => sessionLoadRef.current === generation
          && composerDraftKeyRef.current === ownerKey
          && composerDraftMatches(readComposerDraft(composerDraftsRef.current, ownerKey), original);
        setLongTaskBusy(true);
        try {
          const created = await window.piApi.createConversation({
            cwd: workspace,
            title: goalCommand.text.replace(/\s+/g, ' ').slice(0, 48),
          });
          if (!canApply()) {
            await loadState().catch(() => {});
            return true;
          }
          await window.piApi.conversationAction({
            kind: 'session', id: created.id, action: 'long-task-set', goal: goalCommand.text,
          });
          if (!canApply()) {
            await loadState().catch(() => {});
            return true;
          }
          await loadState().catch(() => {});
          if (!canApply()) return true;
          const navigationGeneration = sessionLoadRef.current + 1;
          const opened = await conversationNavigationRef.current.open(created);
          if (!opened || sessionRef.current?.id !== created.id || sessionLoadRef.current !== navigationGeneration) {
            return true;
          }
          const sourceUnchanged = composerDraftMatches(readComposerDraft(composerDraftsRef.current, ownerKey), original);
          if (sourceUnchanged) clearComposerDraft(composerDraftsRef.current, ownerKey);
          setBusy(true);
          showComposerFeedback(sourceUnchanged
            ? '新目标已建立，正在执行。'
            : '新目标已建立，等待期间的输入已保留在原草稿。', 'info');
        } catch (error) {
          if (canApply()) showComposerFeedback(errorText(error));
        } finally {
          setLongTaskBusy(false);
        }
        return true;
      }
      if (!currentSession?.id) {
        showComposerFeedback('请先打开一个会话，再使用 /goal。', 'info');
        return true;
      }
      if (goalCommand.action === 'view') {
        const state = currentSession.longTask;
        if (!state?.enabled || !state.goal) {
          showComposerFeedback('当前还没有目标。使用 /goal <目标> 开始。', 'info');
        } else {
          const statusLabels: Record<LongTaskState['status'], string> = {
            idle: '等待目标',
            active: '执行中',
            paused: '已暂停',
            blocked: '等待补充',
            completed: '已完成',
            failed: '执行失败',
          };
          const goalPreview = state.goal.length > 320 ? `${state.goal.slice(0, 320)}…` : state.goal;
          showComposerFeedback(`当前目标 · ${statusLabels[state.status]}：${goalPreview}`, 'info');
        }
        return true;
      }
      if ((goalCommand.action === 'set' || goalCommand.action === 'edit') && !goalCommand.text) {
        showComposerFeedback(`/${goalCommand.action} 后需要填写新的目标。`);
        return true;
      }
      const action = goalCommand.action === 'set'
        ? 'long-task-set'
        : goalCommand.action === 'edit'
          ? 'long-task-edit'
          : goalCommand.action === 'complete'
            ? 'long-task-complete'
            : goalCommand.action === 'clear'
              ? 'long-task-clear'
              : goalCommand.action === 'pause'
                ? 'long-task-pause'
                : 'long-task-resume';
      await executeLongTaskAction(action, {
        goal: goalCommand.action === 'set' || goalCommand.action === 'edit'
          ? goalCommand.text
          : undefined,
        summary: goalCommand.action === 'complete' ? goalCommand.text : undefined,
      });
      return true;
    }
    if (command.route === 'assistant.copy') {
      const last = [...messages].reverse().find((message) => message.role === 'assistant');
      const text = last ? textOfBlocks(last.content) : '';
      if (text) await navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  }

  function selectComposerOption(index: number) {
    const menu = composerMenu;
    if (!menu) return;
    if (menu.kind === 'capability' && !menu.capabilityType) {
      const category = composerCapabilityCategories[index];
      if (!category) return;
      setComposerMenu({ ...menu, capabilityType: category.type });
      setComposerMenuIndex(0);
      return;
    }
    const { start, end: caret } = menu;

    function insertOption(token: string) {
      const input = composerEditorRef.current;
      const insertion = insertComposerToken(input?.value ?? prompt, start, caret, token);
      saveComposerDraft(composerDraftsRef.current, composerDraftKeyRef.current, { ...currentComposerDraft(), text: insertion.text });
      if (input) {
        input.focus();
        input.replaceText(insertion.text, insertion.caret);
      } else {
        setPrompt(insertion.text);
      }
      setComposerMenu(null);
    }

    if (menu.kind !== 'slash') {
      const mention = composerMentionOptions[index];
      if (!mention) return;
      const token = 'path' in mention ? formatFileReference(mention.path + (mention.type === 'directory' ? '/' : ''))
        : mention.type === 'agent' ? formatAgentReference(mention) : formatCapabilityReference(mention);
      insertOption(token);
      return;
    }
    const command = composerCommandOptions[index];
    if (!command) return;
    const standalone = !prompt.slice(0, start).trim() && !prompt.slice(caret).trim() && !composerAttachments.length;
    if (standalone && !command.argumentHint && (command.source === 'builtin' || (command.source === 'extension' && command.commandId))) {
      const owner = composerDraftKeyRef.current;
      const generation = sessionLoadRef.current;
      const original = snapshotComposerDraft(currentComposerDraft());
      setComposerMenu(null);
      setComposerMenuIndex(0);
      const execution = command.source === 'builtin'
        ? executeBuiltinCommand(`/${command.name}`)
        : executeExtensionCommand(command.commandId!, '');
      void execution.then(success => {
        if (success && sessionLoadRef.current === generation && composerDraftKeyRef.current === owner && composerDraftMatches(readComposerDraft(composerDraftsRef.current, owner), original)) {
          saveComposerDraft(composerDraftsRef.current, owner, { ...readComposerDraft(composerDraftsRef.current, owner), text: '' });
          setPrompt('');
        }
      }).catch(cause => { if (composerDraftKeyRef.current === owner) setError(errorText(cause)); });
      return;
    }
    insertOption(`/${command.name}`);
  }

  return {
    updateComposerMenu,
    executeBuiltinCommand,
    sendPromptFromExtension,
    executeExtensionCommand,
    findExtensionCommand,
    selectComposerOption,
  };
}
