import { memo, useMemo, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { LoadingIndicator } from '../../shared/LoadingState';
import type {
  ChatMessage,
  ComposerAttachment,
  ComposerCommand,
  ComposerMentionOption,
} from '../../types/chat-types';
import type { ModelCatalog, ModelSelection } from '../../types/model-types';
import type { SessionStateForPersistence } from './useMessageDelivery';
import type { QueuedEditContext, QueuedPrompt } from './composer-types';
import type { ComposerDraft, ComposerDraftStore } from './composer-drafts';
import type { ComposerMenuState } from './useComposerSuggestions';
import { composerCapabilityCategories } from './composer-menu';
import type { ModelPickerRequest } from '../models/ModelPicker';
import type {
  ExtensionUiItem,
  ExtensionUiSnapshot,
} from '../../types/extension-types';
import type { ContextPolicy } from './ContextUsageChip';
import type { ContextUsage } from './context-usage';
import type { PermissionMode, PermissionUiState, SettingsTab } from '../../shell/app-shell-config';
import { permissionOptions } from '../../shell/app-shell-config';
import type { ExtensionNotice } from '../extensions/ExtensionSlot';
import { ExtensionSummaries } from '../extensions/ExtensionSummaries';
import { AttachmentFileDetails } from './AttachmentFileDetails';
import { formatShortcut } from '../../shared/shortcuts';
import { WorkspacePicker } from '../../shell/WorkspacePicker';
import { Select } from '../../shared/Select';
import { composerKeyAction } from './composer-submit';
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor';
import { planComposerPaste } from './composer-paste';
import { pasteExceedsBudget } from './composer-budget.ts';
import { ComposerImageAttachment } from './ComposerImageAttachment';
import { ComposerFeedback } from './ComposerFeedback';
import { ComposerToolbar } from './ComposerToolbar';
import { ComposerSuggestions } from './ComposerSuggestions';
import { NewConversationWelcome } from './NewConversationWelcome';
import { QueuedMessages, type QueuedPreview } from './QueuedMessages';
import { ConversationError } from './ConversationError';
import { ContextUsageChip } from './ContextUsageChip';
import { ModelPicker } from '../models/ModelPicker';

type Setter<T> = Dispatch<SetStateAction<T>>;

export type ComposerDockProps = {
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
  composerEditorRef: MutableRefObject<ComposerEditorHandle | null>;
  composerWrapRef: MutableRefObject<HTMLDivElement | null>;
  composerComposingRef: MutableRefObject<boolean>;
  composerMenu: ComposerMenuState | null;
  composerMenuIndex: number;
  composerMenuLoading: boolean;
  composerMenuError: string | null;
  composerCommandOptions: ComposerCommand[];
  composerMentionOptions: ComposerMentionOption[];
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
  sendPromptFromExtension: (prompt: string, submit: boolean) => void;
  turnActive: boolean;
  stopping: boolean;
  busy: boolean;
  stateLoading: boolean;
  sessionLoading: boolean;
  preparing: boolean;
  compaction: { active: boolean; reason?: string };
  composerFeedback: { message: string; tone: 'info' | 'warning'; sessionId?: string } | null;
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
  onOpenSettings: (page?: SettingsTab) => void;
  selectDraftWorkspace: (cwd: string) => void;
  chooseFile: () => void;
  setActionPaletteOpen: Setter<boolean>;
  error: string | null;
  setError: Setter<string | null>;
  extensionAboveItems: ExtensionUiItem[];
  extensionBelowItems: ExtensionUiItem[];
  openExtensionPanel: (panelId: string) => void;
  extensionSurface: ExtensionUiSnapshot;
  notifyExtension: (notice: ExtensionNotice) => void;
};

function ComposerDockComponent({
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
  composerEditorRef,
  composerWrapRef,
  composerComposingRef,
  composerMenu,
  composerMenuIndex,
  composerMenuLoading,
  composerMenuError,
  composerCommandOptions,
  composerMentionOptions,
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
  setActionPaletteOpen: _setActionPaletteOpen,
  error,
  setError,
  extensionAboveItems,
  extensionBelowItems,
  openExtensionPanel,
  extensionSurface,
  notifyExtension,
}: ComposerDockProps) {
  const choosingCapabilityCategory = composerMenu?.kind === 'capability' && !composerMenu.capabilityType;
  const composerOptionsCount = composerMenu?.kind === 'slash'
    ? composerCommandOptions.length
    : choosingCapabilityCategory ? composerCapabilityCategories.length : composerMentionOptions.length;
  const composerCommandNames = useMemo(
    () => new Set(composerCommands.map((command) => command.name)),
    [composerCommands],
  );
  // 提示按会话归属：带了别的会话 id 就不显示；没有归属的（草稿态）照常显示。
  const scopedComposerFeedback = composerFeedback
    && (!composerFeedback.sessionId || composerFeedback.sessionId === session?.id)
    ? composerFeedback
    : null;
  // 模型没配置时，发送按钮只会禁用；点击输入框时给一条可见的配置入口，
  // 而不是把用户挡在输入框外。
  const hasUsableModel = Boolean(modelSelection.modelRef) && !modelSelection.unavailable;
  const [modelHintOpen, setModelHintOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const extensionContext = {
    surface: extensionSurface,
    cwd: session?.cwd || workspace,
    sessionId: session?.id,
    modelRef: modelSelection.modelRef,
    onOpenSettings,
    onSendPrompt: sendPromptFromExtension,
    onNotify: notifyExtension,
    onOpenPanel: openExtensionPanel,
  };

  function moveWithinMcpMenu(server: ComposerMenuState['mcpServer'], query: string) {
    if (!composerMenu) return;
    const { start, end } = composerMenu;
    const caret = start + 1 + query.length;
    const editor = composerEditorRef.current;
    if (composerMenu.query !== query && editor) {
      editor.replaceText(editor.value.slice(0, start + 1) + query + editor.value.slice(end), caret);
    }
    setComposerMenu({ ...composerMenu, mcpServer: server, query, end: caret });
    setComposerMenuIndex(0);
    editor?.focus();
  }

  function openMcpMethods(index: number) {
    const item = composerMentionOptions[index];
    if (composerMenu?.capabilityType === 'mcp' && item?.type === 'mcp-server') {
      moveWithinMcpMenu({ id: item.id, name: item.name, parentQuery: composerMenu.query }, '');
    }
  }

  function backInCapabilityMenu() {
    if (composerMenu?.kind !== 'capability') return;
    if (composerMenu.mcpServer) {
      moveWithinMcpMenu(undefined, composerMenu.mcpServer.parentQuery);
      return;
    }
    setComposerMenu({ ...composerMenu, capabilityType: undefined });
    setComposerMenuIndex(0);
  }

  return <div className="composer-dock">
    {isNewConversation && <NewConversationWelcome loading={stateLoading} />}
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
    <ExtensionSummaries {...extensionContext} items={extensionAboveItems} slot="composer.above" />
    <div
      className="composer-wrap"
      ref={composerWrapRef}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) setDragOver(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          if (!dragOver) setDragOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(event) => {
        setDragOver(false);
        const dropped = Array.from(event.dataTransfer.files);
        if (dropped.length > 0) {
          event.preventDefault();
          void addComposerFiles(dropped);
        }
      }}
    >
      {composerMenu && <ComposerSuggestions
        menu={composerMenu}
        commandOptions={composerCommandOptions}
        mentionOptions={composerMentionOptions}
        loading={composerMenuLoading}
        error={composerMenuError || ''}
        activeIndex={composerMenuIndex}
        workspace={workspace}
        onHover={setComposerMenuIndex}
        onSelect={selectComposerOption}
        onCategory={kind => {
          const sigil = kind === 'file' ? '@' : kind === 'agent' ? '#' : '$';
          const { start, end, query } = composerMenu;
          setPrompt(prompt.slice(0, start) + sigil + prompt.slice(start + 1));
          setComposerMenu({ kind, start, end, query });
          setComposerMenuIndex(0);
          requestAnimationFrame(() => {
            composerEditorRef.current?.focus();
            composerEditorRef.current?.setSelectionRange(end, end);
          });
        }}
        onBack={backInCapabilityMenu}
        onOpenMethods={openMcpMethods}
        onRetry={retryComposerSuggestions}
      />}
      {session?.id && compaction.active && <div className="compaction-banner" role="status"><LoadingIndicator /><span>正在压缩我们的对话内容，以便继续对话…</span></div>}
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
      {/* 提示属于触发它的那条会话：切换后不再跟到别的输入框上 */}
      {scopedComposerFeedback && <ComposerFeedback
        message={scopedComposerFeedback.message}
        tone={scopedComposerFeedback.tone}
        onDismiss={() => setComposerFeedback(null)}
      />}
      {composerAttachments.length > 0 && <div className="attachment-strip composer-attachments" role="group" aria-label="待发送附件">
        {composerAttachments.map((attachment) => {
          if (attachment.kind === 'image') return <ComposerImageAttachment
            key={attachment.id}
            images={composerImages}
            index={composerImageIndexes.get(attachment.id) ?? 0}
            onRemove={() => removeComposerAttachment(attachment.id)}
          />;
          const path = attachment.path;
          const content = <AttachmentFileDetails attachment={attachment} />;
          return <div className="composer-attachment is-file" key={attachment.id}>
            {path
              ? <button
                type="button"
                className="composer-file-content"
                title={path}
                aria-label={`在右侧面板查看 ${attachment.name}`}
                onClick={() => void openFile(path, session?.id, 'attachment')}
              >{content}</button>
              : <div className="composer-file-content" title={attachment.name}>{content}</div>}
            <button
              type="button"
              className="composer-attachment-remove"
              aria-label={`移除 ${attachment.name}`}
              title="移除"
              onClick={() => removeComposerAttachment(attachment.id)}
            ><X /></button>
          </div>;
        })}
      </div>}
      <div className={`composer${dragOver ? ' is-drag-over' : ''}`}>
        <div className="composer-input">
          <ComposerEditor
            ref={composerEditorRef}
            value={prompt}
            scope={composerDraftKeyRef.current}
            commandNames={composerCommandNames}
            onChange={(value, cursor) => {
              // Draft persistence is owned by the prompt effect so typing does not
              // double-notify the draft store on every keystroke.
              setPrompt(value);
              updateComposerMenu(value, cursor);
            }}
            onClick={() => {
              updateComposerMenu(prompt, composerEditorRef.current?.selectionStart ?? prompt.length);
              if (!hasUsableModel && !stateLoading) setModelHintOpen(true);
            }}
            onPaste={(event) => {
              const node = composerEditorRef.current;
              if (!node) return;
              const files = Array.from(event.clipboardData.files);
              const text = event.clipboardData.getData('text/plain');
              if (files.length > 0) {
                event.preventDefault();
                void addComposerFiles(files);
              }
              if (!text) return;
              const paste = planComposerPaste(node.value, node.selectionStart, node.selectionEnd, text);
              if (!pasteExceedsBudget(paste.baseText, text)) {
                if (files.length > 0) node.replaceSelection(text);
                return;
              }
              event.preventDefault();
              node.replaceSelection('');
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
                canOpenMethods: composerMentionOptions[composerMenuIndex]?.type === 'mcp-server',
                pending: composerMenuLoading || Boolean(composerMenuError || composerMenu?.capabilityType),
              });
              if (action === 'none') return;
              event.preventDefault();
              if (action === 'previous') setComposerMenuIndex(index => (index - 1 + composerOptionsCount) % composerOptionsCount);
              else if (action === 'next') setComposerMenuIndex(index => (index + 1) % composerOptionsCount);
              else if (action === 'select') selectComposerOption(composerMenuIndex);
              else if (action === 'methods') openMcpMethods(composerMenuIndex);
              else if (action === 'close') {
                if (composerMenu?.capabilityType) backInCapabilityMenu();
                else setComposerMenu(null);
              }
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
              ? '正在压缩上下文…'
              : queuedEditContext
                ? `编辑排队消息，${formatShortcut('Mod+Enter')} 保存`
                : turnActive
                  ? `补充当前任务，或 ${formatShortcut('Mod+Enter')} 排队`
                  : '输入消息…'}
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
          onSend={() => void send()}
          onQueue={() => void send(undefined, 'queue')}
          onStop={() => void stopGeneration()}
          context={<>
            {isNewConversation && <WorkspacePicker value={workspace} workspaces={workspaces} onChange={selectDraftWorkspace} onBrowse={chooseFile} />}
            {visiblePermission?.status === 'ready' && visiblePermission.available && (
              <span
                className={`composer-mode${visiblePermission.mode === 'full' ? ' is-permission-full' : ''}`}
                title={visiblePermission.mode === 'full' ? '完全权限：操作将直接执行，不再询问' : 'Studio 工具权限模式'}
              >
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
              onOpenSettings={() => onOpenSettings('harness-compaction')}
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
    <ExtensionSummaries {...extensionContext} items={extensionBelowItems} slot="composer.below" />
    {isNewConversation && error && <ConversationError className="new-conversation-error" message={error} onDismiss={() => setError(null)} />}
  </div>;
}

/** Skip chrome-only parent renders when the prop bag is referentially stable. */
export const ComposerDock = memo(ComposerDockComponent);
