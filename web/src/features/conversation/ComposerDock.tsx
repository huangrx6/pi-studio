import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  LoaderCircle,
  PanelRightOpen,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type {
  ChatMessage,
  ComposerAttachment,
  ComposerCommand,
  ComposerFile,
  TodoDetails,
} from '../../types/chat-types';
import type { ModelCatalog, ModelSelection } from '../../types/model-types';
import type { SessionStateForPersistence } from './useMessageDelivery';
import type { QueuedEditContext, QueuedPrompt } from './composer-types';
import type { ComposerDraft, ComposerDraftStore } from './composer-drafts';
import { readComposerDraft, saveComposerDraft } from './composer-drafts';
import type { ComposerMenuState } from './useComposerSuggestions';
import type { ModelPickerRequest } from '../models/ModelPicker';
import type {
  ExtensionSettingsPage,
  ExtensionUiItem,
  ExtensionUiSnapshot,
} from '../../types/extension-types';
import type { ContextPolicy } from './ContextUsageChip';
import type { ContextUsage } from './context-usage';
import type { PermissionMode, PermissionUiState } from '../../shell/app-shell-config';
import { permissionOptions } from '../../shell/app-shell-config';
import { ExtensionSlot, type ExtensionNotice } from '../extensions/ExtensionSlot';
import { AttachmentIcon } from '../../shared/AttachmentIcon';
import { WorkspacePicker } from '../../shell/WorkspacePicker';
import { Select } from '../../shared/Select';
import { formatFileSize } from '../../shared/filesize';
import { composerKeyAction } from './composer-submit';
import { planComposerPaste } from './composer-paste';
import { pasteExceedsBudget } from './composer-budget.mjs';
import { splitComposerText } from './references';
import { ComposerImageAttachment } from './ComposerImageAttachment';
import { ComposerFeedback } from './ComposerFeedback';
import { ComposerToolbar } from './ComposerToolbar';
import { ComposerSuggestions } from './ComposerSuggestions';
import { NewConversationWelcome } from './NewConversationWelcome';
import { LongTaskDock } from './LongTaskDock';
import { TodoDock } from './TodoDock';
import { QueuedMessages, type QueuedPreview } from './QueuedMessages';
import { ConversationError } from './ConversationError';
import { ContextUsageChip } from './ContextUsageChip';
import { ModelPicker } from '../models/ModelPicker';
import {
  ConversationExtensionDock,
} from '../extensions/ConversationExtensionHub';

type Setter<T> = Dispatch<SetStateAction<T>>;

export type ComposerDockProps = {
  open: boolean;
  isNewConversation: boolean;
  workspace: string;
  workspaces: Array<{ cwd: string; name: string }>;
  session: SessionStateForPersistence;
  modelSelection: ModelSelection;
  prompt: string;
  setPrompt: Setter<string>;
  composerAttachments: ComposerAttachment[];
  composerImages: Array<{ src: string; alt: string }>;
  composerImageIndexes: Map<string, number>;
  composerDraftKeyRef: MutableRefObject<string>;
  composerDraftsRef: MutableRefObject<ComposerDraftStore>;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  composerHighlightRef: MutableRefObject<HTMLDivElement | null>;
  composerWrapRef: MutableRefObject<HTMLDivElement | null>;
  composerComposingRef: MutableRefObject<boolean>;
  composerMenu: ComposerMenuState | null;
  composerMenuIndex: number;
  composerMenuLoading: boolean;
  composerMenuError: string | null;
  composerCommandOptions: ComposerCommand[];
  composerFileOptions: ComposerFile[];
  composerCommands: ComposerCommand[];
  updateComposerMenu: (value: string, cursor: number) => void;
  setComposerMenu: Setter<ComposerMenuState | null>;
  setComposerMenuIndex: Setter<number>;
  selectComposerOption: (index: number) => void;
  retryComposerSuggestions: () => void;
  addComposerFiles: (files: File[]) => Promise<void>;
  attachPastedText: (paste: ReturnType<typeof planComposerPaste>) => Promise<void>;
  removeComposerAttachment: (id: string) => void;
  pickComposerAttachments: () => Promise<void>;
  openFile: (path: string, sessionId?: string, source?: 'attachment') => Promise<boolean>;
  send: (input?: string, mode?: 'queue') => Promise<void>;
  stopGeneration: () => Promise<void>;
  sendQueuedNow: (id: string) => Promise<void>;
  sendAllQueued: () => Promise<void>;
  editQueued: (id: string) => void;
  deleteQueued: (id: string) => void;
  reorderQueued: (source: string, target: string) => void;
  queuedPrompts: QueuedPrompt[];
  queuedPreviews: QueuedPreview[];
  queuedEditContext?: QueuedEditContext;
  queueAdmissionPending: boolean;
  todoDetails?: TodoDetails;
  todoPanelOpen: boolean;
  setTodoPanelOpen: Setter<boolean>;
  longTaskBusy: boolean;
  changeLongTaskStatus: (action: 'long-task-pause' | 'long-task-resume') => Promise<void>;
  sendPromptFromExtension: (prompt: string, submit: boolean) => void;
  turnActive: boolean;
  stopping: boolean;
  busy: boolean;
  stateLoading: boolean;
  sessionLoading: boolean;
  preparing: boolean;
  compaction: { active: boolean; reason?: string };
  composerFeedback: { message: string; tone: 'info' | 'warning' } | null;
  setComposerFeedback: Setter<{ message: string; tone: 'info' | 'warning' } | null>;
  visiblePermission: PermissionUiState | null;
  changePermission: (mode: PermissionMode) => Promise<void>;
  retryPermissionMode: () => Promise<void>;
  contextUsageInfo: ContextUsage | null;
  activeContextPolicy: ContextPolicy | null;
  compactContext: () => Promise<void>;
  settingsOpen: boolean;
  loadModelCatalog: (cwd: string) => Promise<ModelCatalog>;
  selectModel: (modelRef: string) => Promise<void>;
  selectThinking: (level: ModelSelection['thinkingLevel']) => Promise<void>;
  modelPickerRequest: ModelPickerRequest | null;
  modelPickerContextKey: string;
  setModelPickerRequest: Setter<ModelPickerRequest | null>;
  onConfigureModels: () => void;
  onOpenSettings: (page?: ExtensionSettingsPage) => void;
  selectDraftWorkspace: (cwd: string) => void;
  chooseFile: () => void;
  setActionPaletteOpen: Setter<boolean>;
  error: string | null;
  setError: Setter<string | null>;
  conversationFooterExtensionItems: ExtensionUiItem[];
  extensionSurface: ExtensionUiSnapshot;
  notifyExtension: (notice: ExtensionNotice) => void;
};

export function ComposerDock({
  open,
  isNewConversation,
  workspace,
  workspaces,
  session,
  modelSelection,
  prompt,
  setPrompt,
  composerAttachments,
  composerImages,
  composerImageIndexes,
  composerDraftKeyRef,
  composerDraftsRef,
  textareaRef,
  composerHighlightRef,
  composerWrapRef,
  composerComposingRef,
  composerMenu,
  composerMenuIndex,
  composerMenuLoading,
  composerMenuError,
  composerCommandOptions,
  composerFileOptions,
  composerCommands,
  updateComposerMenu,
  setComposerMenu,
  setComposerMenuIndex,
  selectComposerOption,
  retryComposerSuggestions,
  addComposerFiles,
  attachPastedText,
  removeComposerAttachment,
  pickComposerAttachments,
  openFile,
  send,
  stopGeneration,
  sendQueuedNow,
  sendAllQueued,
  editQueued,
  deleteQueued,
  reorderQueued,
  queuedPrompts,
  queuedPreviews,
  queuedEditContext,
  queueAdmissionPending,
  todoDetails,
  todoPanelOpen,
  setTodoPanelOpen,
  longTaskBusy,
  changeLongTaskStatus,
  sendPromptFromExtension,
  turnActive,
  stopping,
  busy,
  stateLoading,
  sessionLoading,
  preparing,
  compaction,
  composerFeedback,
  setComposerFeedback,
  visiblePermission,
  changePermission,
  retryPermissionMode,
  contextUsageInfo,
  activeContextPolicy,
  compactContext,
  settingsOpen,
  loadModelCatalog,
  selectModel,
  selectThinking,
  modelPickerRequest,
  modelPickerContextKey,
  setModelPickerRequest,
  onConfigureModels,
  onOpenSettings,
  selectDraftWorkspace,
  chooseFile,
  setActionPaletteOpen,
  error,
  setError,
  conversationFooterExtensionItems,
  extensionSurface,
  notifyExtension,
}: ComposerDockProps) {
  const composerOptionsCount = composerMenu?.kind === 'slash'
    ? composerCommandOptions.length
    : composerFileOptions.length;
  const composerCommandNames = useMemo(
    () => new Set(composerCommands.map((command) => command.name)),
    [composerCommands],
  );
  const composerSegments = useMemo(
    () => splitComposerText(prompt, composerCommandNames),
    [prompt, composerCommandNames],
  );
  // 计划全部完成时自动收起计划栏：完成的清单只留一行摘要，把高度还给消息区。
  // 用户随后手动展开就不再自动收起，直到出现新的未完成任务。
  const todoAllDone = useMemo(() => {
    const tracked = (todoDetails?.tasks ?? []).filter((task) => !task.archivedAt && !task.closedAt && task.status !== 'deleted');
    return tracked.length > 0 && tracked.every((task) => task.status === 'completed');
  }, [todoDetails]);
  const todoAutoCollapsedRef = useRef(false);
  useEffect(() => {
    if (!todoAllDone) {
      todoAutoCollapsedRef.current = false;
      return;
    }
    if (todoAutoCollapsedRef.current) return;
    todoAutoCollapsedRef.current = true;
    setTodoPanelOpen(false);
  }, [todoAllDone, setTodoPanelOpen]);

  // 模型没配置时，发送按钮只会禁用；点击输入框时给一条可见的配置入口，
  // 而不是把用户挡在输入框外。
  const hasUsableModel = Boolean(modelSelection.modelRef) && !modelSelection.unavailable;
  const [modelHintOpen, setModelHintOpen] = useState(false);

  return <div className="composer-dock" hidden={!open}>
    {isNewConversation && <NewConversationWelcome
      hasWorkspace={Boolean(workspace)}
      hasDraft={Boolean(prompt.trim() || composerAttachments.length)}
      loading={stateLoading}
      onSelectPrompt={(text) => {
        setPrompt((current) => current.trim() ? `${current}\n\n${text}` : text);
        setComposerMenu(null);
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(textareaRef.current.value.length, textareaRef.current.value.length);
        });
      }}
    />}
    {!isNewConversation && (
      <LongTaskDock
        state={session?.longTask}
        running={turnActive}
        busy={longTaskBusy}
        onChange={(action) => void changeLongTaskStatus(action)}
        onEditGoal={() => sendPromptFromExtension('/goal ', false)}
      />
    )}
    {(todoDetails || todoPanelOpen) && <TodoDock details={todoDetails} open={todoPanelOpen} onToggle={() => setTodoPanelOpen((value) => !value)} />}
    {queuedPrompts.length > 0 && <QueuedMessages
      items={queuedPreviews}
      canSteer={turnActive}
      sendDisabled={stateLoading || sessionLoading || stopping || compaction.active || queueAdmissionPending}
      onEdit={editQueued}
      onDelete={deleteQueued}
      onSendNow={(id) => void sendQueuedNow(id)}
      onSendAll={() => void sendAllQueued()}
      onReorder={reorderQueued}
    />}
    {isNewConversation && !workspace && <p id="workspace-selection-hint" className="sr-only" role="status">选择工作区后才能发送第一条消息</p>}
    <div className="composer-wrap" ref={composerWrapRef}>
      {composerMenu && <ComposerSuggestions
        menu={composerMenu}
        commandOptions={composerCommandOptions}
        fileOptions={composerFileOptions}
        loading={composerMenuLoading}
        error={composerMenuError || ''}
        activeIndex={composerMenuIndex}
        workspace={workspace}
        onHover={setComposerMenuIndex}
        onSelect={selectComposerOption}
        onRetry={retryComposerSuggestions}
      />}
      {session?.id && compaction.active && <div className="compaction-banner" role="status"><LoaderCircle className="spin" /><span>上下文正在压缩，完成后会自动继续…</span></div>}
    {!hasUsableModel && modelHintOpen && <div className="composer-model-hint" role="status">
        <SlidersHorizontal aria-hidden="true" />
        <span>还没有可用模型，发送前先挑一个。</span>
        <button
          type="button"
          className="composer-model-hint-action"
          onClick={() => { setModelHintOpen(false); onConfigureModels(); }}
        >配置模型</button>
        <button
          type="button"
          className="composer-model-hint-close"
          aria-label="关闭模型提示"
          onClick={() => setModelHintOpen(false)}
        ><X aria-hidden="true" /></button>
      </div>}
      <ExtensionSlot
        slot="composer.before"
        cwd={workspace}
        sessionId={session?.id}
        modelRef={modelSelection.modelRef}
        onOpenSettings={(page) => { if (page) onOpenSettings(page); }}
        onSendPrompt={sendPromptFromExtension}
        onNotify={notifyExtension}
      />
      {composerFeedback && <ComposerFeedback
        message={composerFeedback.message}
        tone={composerFeedback.tone}
        onDismiss={() => setComposerFeedback(null)}
      />}
      <div
        className="composer"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={(event) => {
          const dropped = Array.from(event.dataTransfer.files);
          if (dropped.length > 0) {
            event.preventDefault();
            void addComposerFiles(dropped);
          }
        }}
      >
        {composerAttachments.length > 0 && <div className="composer-attachments">
          {composerAttachments.map((attachment) => attachment.kind === 'image'
            ? <ComposerImageAttachment
              key={attachment.id}
              images={composerImages}
              index={composerImageIndexes.get(attachment.id) ?? 0}
              onRemove={() => removeComposerAttachment(attachment.id)}
            />
            : <div
              className="composer-attachment is-file is-openable"
              key={attachment.id}
              title={attachment.path}
              role={attachment.path ? 'button' : undefined}
              tabIndex={attachment.path ? 0 : undefined}
              aria-label={attachment.path ? `在右侧面板查看 ${attachment.name}` : undefined}
              onClick={() => { if (attachment.path) void openFile(attachment.path, session?.id, 'attachment'); }}
              onKeyDown={(event) => {
                if (attachment.path && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  void openFile(attachment.path, session?.id, 'attachment');
                }
              }}
            >
              <AttachmentIcon name={attachment.name} mime={attachment.mime} />
              <span><strong>{attachment.name}</strong><small>{formatFileSize(attachment.bytes)}{attachment.lines ? ` · ${attachment.lines.toLocaleString('zh-CN')} 行` : ''}</small></span>
              {attachment.path && <span className="attachment-open-cue" title="在右侧面板查看" aria-hidden="true"><PanelRightOpen /></span>}
              <button
                type="button"
                className="composer-attachment-remove"
                aria-label={`移除 ${attachment.name}`}
                onClick={(event) => { event.stopPropagation(); removeComposerAttachment(attachment.id); }}
                onKeyDown={(event) => event.stopPropagation()}
              ><X /></button>
            </div>)}
        </div>}
        <div className="composer-input">
          <div className="composer-highlight" ref={composerHighlightRef} aria-hidden="true">
            {composerSegments.map((segment, index) => segment.kind === 'text'
              ? <span key={index}>{segment.text}</span>
              : <span key={index} className={`composer-token is-${segment.tokenKind}`}>
                <span className="composer-token-prefix">{segment.text.slice(0, 1)}</span>
                {segment.text.slice(1)}
              </span>)}
            {prompt.endsWith('\n') && <span>{'\u200b'}</span>}
          </div>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(event) => {
              const value = event.target.value;
              const key = composerDraftKeyRef.current;
              saveComposerDraft(composerDraftsRef.current, key, {
                ...readComposerDraft(composerDraftsRef.current, key),
                text: value,
              });
              setPrompt(value);
              updateComposerMenu(value, event.target.selectionStart ?? value.length);
            }}
            onClick={(event) => {
              updateComposerMenu(prompt, event.currentTarget.selectionStart ?? prompt.length);
              if (!hasUsableModel && !stateLoading) setModelHintOpen(true);
            }}
            onPaste={(event) => {
              const node = event.currentTarget;
              const files = Array.from(event.clipboardData.files);
              const text = event.clipboardData.getData('text');
              // File clipboard formats may also carry useful plain text. Keep both.
              if (files.length > 0) {
                event.preventDefault();
                void addComposerFiles(files);
              }
              if (!text) return;
              const paste = planComposerPaste(node.value, node.selectionStart, node.selectionEnd, text);
              if (!pasteExceedsBudget(paste.baseText, text)) {
                if (files.length === 0) return; // Preserve browser-native ordinary paste.
                node.setRangeText(text, node.selectionStart, node.selectionEnd, 'end');
                saveComposerDraft(composerDraftsRef.current, composerDraftKeyRef.current, {
                  ...readComposerDraft(composerDraftsRef.current, composerDraftKeyRef.current),
                  text: node.value,
                });
                setPrompt(node.value);
                updateComposerMenu(node.value, node.selectionStart);
                return;
              }
              event.preventDefault();
              saveComposerDraft(composerDraftsRef.current, composerDraftKeyRef.current, {
                ...readComposerDraft(composerDraftsRef.current, composerDraftKeyRef.current),
                text: paste.baseText,
              });
              setPrompt(paste.baseText);
              setComposerMenu(null);
              void attachPastedText(paste);
            }}
            onKeyDown={(event) => {
              const action = composerKeyAction({
                key: event.key,
                shiftKey: event.shiftKey,
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
                isComposing: composerComposingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229,
                busy: turnActive,
                menuOpen: Boolean(composerMenu),
                optionCount: composerOptionsCount,
                pending: composerMenuLoading || Boolean(composerMenuError),
              });
              if (action === 'none') return;
              event.preventDefault();
              if (action === 'previous') setComposerMenuIndex(index => (index - 1 + composerOptionsCount) % composerOptionsCount);
              else if (action === 'next') setComposerMenuIndex(index => (index + 1) % composerOptionsCount);
              else if (action === 'select') selectComposerOption(composerMenuIndex);
              else if (action === 'close') setComposerMenu(null);
              else if (action === 'queue') void send(undefined, 'queue');
              else if (action === 'send' || action === 'steer') void send();
            }}
            onCompositionStart={() => { composerComposingRef.current = true; }}
            onCompositionEnd={() => { composerComposingRef.current = false; }}
            onBlur={() => { composerComposingRef.current = false; }}
            aria-autocomplete="list"
            aria-controls={composerMenu ? 'composer-suggestions' : undefined}
            aria-activedescendant={composerMenu && composerOptionsCount > composerMenuIndex ? `composer-suggestion-${composerMenuIndex}` : undefined}
            aria-label="发送给 Pi 的消息"
            aria-describedby={isNewConversation && !workspace ? 'workspace-selection-hint' : undefined}
            spellCheck={false}
            className={queuedPrompts.length > 0 ? 'has-queued' : undefined}
            aria-expanded={Boolean(composerMenu)}
            placeholder={compaction.active
              ? '正在压缩上下文，完成后自动继续…'
              : queuedEditContext
                ? '编辑排队消息 · Cmd/Ctrl+Enter 放回原位置 · Shift+Enter 换行'
                : turnActive
                  ? 'Enter 补充当前任务 · Cmd/Ctrl+Enter 排队 · Shift+Enter 换行'
                  : '输入问题，或使用 / 命令、@ 文件…'}
            rows={1}
            onScroll={(event) => {
              // 高亮层与 textarea 同步滚动，保证长文本换行时不错位。
              if (composerHighlightRef.current) {
                composerHighlightRef.current.scrollTop = event.currentTarget.scrollTop;
                composerHighlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }
            }}
          />
        </div>
        <ComposerToolbar
          isNewConversation={isNewConversation}
          attachingDisabled={busy}
          attachmentTitle={modelSelection.supportsImages === false ? '添加文件；当前模型不支持图片' : '添加图片或文件'}
          running={turnActive}
          stopping={stopping}
          compacting={compaction.active}
          hasWorkspace={Boolean(workspace)}
          hasModel={hasUsableModel}
          isCommand={composerAttachments.length === 0 && prompt.trim().startsWith('/')}
          hasContent={Boolean(prompt.trim() || composerAttachments.length)}
          loading={stateLoading || sessionLoading}
          preparing={preparing}
          onAttach={() => void pickComposerAttachments()}
          onActions={() => { setComposerMenu(null); setActionPaletteOpen(true); }}
          onSend={() => void send()}
          onStop={() => void stopGeneration()}
          context={<>
            {isNewConversation && <WorkspacePicker value={workspace} workspaces={workspaces} onChange={selectDraftWorkspace} onBrowse={chooseFile} />}
            {visiblePermission?.status === 'ready' && visiblePermission.available && (
              <span className="composer-mode" title="Studio 工具权限模式">
                <Select
                  label="权限模式"
                  className="composer-mode-select"
                  value={visiblePermission.mode}
                  options={permissionOptions}
                  leadingIcon={<ShieldCheck />}
                  onChange={(value) => void changePermission(value as PermissionMode)}
                />
              </span>
            )}
            {visiblePermission?.status === 'error' && (
              <button
                type="button"
                className="settings-text-button"
                onClick={() => void retryPermissionMode()}
              >
                权限状态读取失败 · 重试
              </button>
            )}
            {!isNewConversation && <ContextUsageChip
              usage={contextUsageInfo}
              policy={activeContextPolicy}
              compacting={compaction.active}
              disabled={!session?.id || stateLoading}
              onCompact={() => void compactContext()}
              onOpenSettings={() => onOpenSettings('harness')}
            />}
          </>}
          model={<ModelPicker
            contextKey={modelPickerContextKey}
            selection={modelSelection}
            scope={session ? 'session' : 'default'}
            disabled={stateLoading || sessionLoading}
            hidden={settingsOpen}
            loadCatalog={() => loadModelCatalog(workspace)}
            onSelectModel={selectModel}
            onSelectThinking={selectThinking}
            onManage={onConfigureModels}
            request={modelPickerRequest}
            onRequestHandled={() => setModelPickerRequest(null)}
          />}
        />
      </div>
    </div>
    <ExtensionSlot
      slot="status.bar"
      hostGlobalPanels
      cwd={workspace}
      sessionId={session?.id}
      modelRef={modelSelection.modelRef}
      onOpenSettings={(page) => { if (page) onOpenSettings(page); }}
      onSendPrompt={sendPromptFromExtension}
      onNotify={notifyExtension}
    />
    {!isNewConversation && conversationFooterExtensionItems.length > 0 && (
      <ConversationExtensionDock
        items={conversationFooterExtensionItems}
        surface={extensionSurface}
        placement="footer"
        cwd={session?.cwd}
        sessionId={session?.id}
        modelRef={modelSelection.modelRef}
        onOpenSettings={(page) => { if (page) onOpenSettings(page); }}
        onSendPrompt={sendPromptFromExtension}
        onNotify={notifyExtension}
      />
    )}
    {isNewConversation && error && <ConversationError className="new-conversation-error" message={error} onDismiss={() => setError(null)} />}
  </div>;
}
