import { Accordion } from '../../shared/Accordion';
import { memo, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, PanelRightOpen } from 'lucide-react';
import type { ChatMessage, ContentBlock } from '../../types/chat-types';
import { AttachmentIcon } from '../../shared/AttachmentIcon';
import { LoadingIndicator } from '../../shared/LoadingState';
import { previewTypeLabel } from '../../shared/file-preview';
import { isComposingKey } from '../../shared/keyboard-navigation';
import { ConversationImageGallery } from './ConversationImageGallery';
import { imagesFromBlocks, textBlocks } from './message-content';
import { MessageActions } from './MessageActions';
import { readableComposerReferences, splitMessageText, type Reference } from './references';
import { ReferenceChip } from './ReferenceChip';
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor';
import './styles/user-message.css';

const editCommands = new Set<string>();

/**
 * 内联图片列表。
 * 只取 image 块，base64 数据直接拼成 data URI；没有任何图片时不占位。
 *
 * @param blocks 消息内容块（用户消息或工具结果都可能带图片）
 */
function MessageImages({ blocks }: { blocks: ContentBlock[] }) {
  const images = imagesFromBlocks(blocks);
  if (images.length === 0) return null;
  return <ConversationImageGallery className="message-images" images={images} />;
}

/** 字节数转可读体积；附件卡片用，保留一位小数。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * 与输入框共用引用徽章及文件类型图标。
 * 技能块还会把展开后的正文收进可折叠详情，避免一屏都是 SKILL.md。
 */
function MessageReference({ reference }: { reference: Reference }) {
  return <>
    <ReferenceChip reference={reference} />
    {reference.kind === 'skill' && reference.body && <Accordion className="ref-skill-body" summary="技能内容" compact>
      <pre>{reference.body}</pre>
    </Accordion>}
  </>;
}

/** 用户正文：普通文本原样输出，技能/文件引用替换成徽章（不改变消息本身）。 */
function UserText({ text }: { text: string }) {
  const segments = splitMessageText(text);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const id = useId();
  // Short replies never need a disclosure; skip ResizeObserver cost on long histories.
  const maybeLong = text.length > 160 || text.includes('\n');
  useLayoutEffect(() => {
    setExpanded(false);
    if (!maybeLong) {
      setOverflow(false);
      return;
    }
    const node = content.current;
    if (!node) return;
    const measure = () => setOverflow(node.getBoundingClientRect().height > parseFloat(getComputedStyle(node).lineHeight) * 5 + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, maybeLong]);
  return <div ref={container} className={`user-text-disclosure ${overflow && !expanded ? 'is-collapsed' : ''}`}>
    <div id={id} className="user-text-viewport"><div ref={content} className="user-text">
    {segments.map((segment, index) => {
      if (segment.kind === 'reference') return <MessageReference key={index} reference={segment.reference} />;
      const before = segments[index - 1];
      // Older messages can have prose immediately after an inline reference.
      const gap = before?.kind === 'reference' && !before.reference.body && /^[\p{L}\p{N}]/u.test(segment.text) ? ' ' : '';
      return <span key={index}>{gap + segment.text}</span>;
    })}
    </div></div>
    {overflow && <button type="button" className="user-text-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => {
      if (expanded && container.current && container.current.getBoundingClientRect().top < 0) container.current.scrollIntoView({ block: 'start' });
      setExpanded(value => !value);
    }}><span>{expanded ? '收起' : '展开更多'}</span><ChevronDown aria-hidden="true" /></button>}
  </div>;
}

/**
 * 单条用户消息气泡。
 *
 * 正文取文本块；附件来自主进程落盘后的 ChatAttachment（展示体积与行数），
 * 图片则从 content 的 image 块内联渲染。
 *
 * @param message 必须是 role === 'user'；assistant / toolResult 由其他视图处理
 * @param id 锚点 id，供右侧大纲跳转
 */
type ChatMessageViewProps = {
  message: ChatMessage;
  id?: string;
  onOpenFile?: (path: string) => void;
  onEdit?: (entryId: number, text: string) => Promise<void>;
  editDisabled?: boolean;
};

function ChatMessageViewComponent({ message, id, onOpenFile, onEdit, editDisabled = false }: ChatMessageViewProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);
  const roleEditRef = useRef<ComposerEditorHandle>(null);
  // 兜底：同一组件被误用于其他角色时不渲染，避免出现空气泡。
  if (message.role !== 'user') return null;
  const text = textBlocks(message.content);
  const messageImages = imagesFromBlocks(message.content).map((image) => image.src);
  // 历史里技能命令已被展开成 <skill> 块；复制时还原成用户实际输入的命令形式。
  const segments = splitMessageText(text);
  const hasReferenceChip = segments.some(part => part.kind === 'reference' && (part.reference.kind === 'agent' || part.reference.capabilityId));
  const copyText = segments
    .map((segment) => segment.kind === 'text'
      ? segment.text
      : segment.reference.kind === 'skill' && !segment.reference.capabilityId
        ? `/skill:${segment.reference.label}`
        : segment.reference.token)
    .join('')
    .trim();
  const preservedCount = messageImages.length + (message.attachments?.length ?? 0);
  const canEdit = Boolean(onEdit && Number.isSafeInteger(message.sourceIndex));

  function resizeEdit() {
    const node = editRef.current;
    if (!node) return;
    node.style.height = '0px';
    node.style.height = `${Math.min(320, Math.max(84, node.scrollHeight))}px`;
  }

  function beginEdit() {
    if (!canEdit || editDisabled) return;
    setDraft(copyText);
    setEditError('');
    setEditing(true);
    requestAnimationFrame(() => {
      const editor = roleEditRef.current;
      if (editor) {
        editor.focus();
        editor.setSelectionRange(editor.value.length, editor.value.length);
        return;
      }
      resizeEdit();
      const node = editRef.current;
      if (!node) return;
      node.focus();
      node.selectionStart = node.selectionEnd = node.value.length;
    });
  }

  function cancelEdit() {
    if (savingEdit) return;
    setEditing(false);
    setEditError('');
  }

  async function saveEdit() {
    if (!onEdit || !canEdit || savingEdit || editDisabled) return;
    const next = draft.trim();
    // Empty draft cannot be sent. Unchanged text still resubmits so a failed
    // turn can be retried without forcing a cosmetic rewrite.
    if (!next) {
      setEditing(false);
      return;
    }
    setSavingEdit(true);
    setEditError('');
    try {
      await onEdit(message.sourceIndex as number, next);
      setEditing(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingEdit(false);
    }
  }

  function onEditKey(event: KeyboardEvent<HTMLElement>) {
    if (isComposingKey(event.nativeEvent)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void saveEdit();
    }
  }

  return <div id={id} className={`message user ${editing ? 'is-editing' : ''}`}>
  {editing
    ? <div className="message-edit">
      <div className="message-edit-body">
        {hasReferenceChip ? <ComposerEditor ref={roleEditRef} value={draft} scope={id || 'edit'} readOnly={savingEdit}
          aria-label="编辑消息" placeholder="编辑消息" commandNames={editCommands}
          onChange={setDraft} onKeyDown={onEditKey} /> : <textarea
          ref={editRef}
          value={draft}
          aria-label="编辑消息"
          disabled={savingEdit}
          onChange={(event) => {
            setDraft(event.target.value);
            requestAnimationFrame(resizeEdit);
          }}
          onKeyDown={onEditKey}
        />}
        {preservedCount > 0 && <div className="message-edit-preserved">保留 {preservedCount} 个图片或附件</div>}
        {editError && <div className="message-edit-error" role="alert">{editError}</div>}
      </div>
      <div className="message-edit-actions">
        <button type="button" className="message-edit-cancel" disabled={savingEdit} onClick={cancelEdit}>取消</button>
        <button type="button" className="message-edit-send" disabled={savingEdit || !draft.trim()} onClick={() => void saveEdit()}>
          {savingEdit ? <LoadingIndicator /> : null}
          {savingEdit ? '发送中' : (draft.trim() === copyText ? '重新发送' : '发送')}
        </button>
      </div>
    </div>
    : <div className="user-message">
    {/* 图片/文件与正文同属一个气泡：附件在上横排滚动，正文在下，避免附件“飘”在气泡外。 */}
    {(preservedCount > 0 || text) && <div className={`user-bubble${preservedCount > 0 ? ' has-attachments' : ''}${text ? ' has-text' : ''}`}>
      {preservedCount > 0 && <div className="user-attachments">
        <MessageImages blocks={message.content} />
        {message.attachments?.map((attachment) => {
          const openable = Boolean(attachment.path && onOpenFile);
          return <div className={`attachment-card ${openable ? 'is-openable' : ''}`} key={attachment.path} title={`${attachment.path}${openable ? ' · 点击查看' : ''}`}
            role={openable ? 'button' : undefined} tabIndex={openable ? 0 : undefined} aria-label={openable ? `在右侧面板查看 ${attachment.name}` : undefined}
            onClick={() => { if (openable) onOpenFile?.(attachment.path); }}
            onKeyDown={(event) => { if (openable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpenFile?.(attachment.path); } }}>
            <AttachmentIcon name={attachment.name} mime={attachment.mime} />
            <span className="attachment-main"><strong title={attachment.name}>{attachment.name}</strong><span>{formatBytes(attachment.bytes)}{attachment.lines ? ` · ${attachment.lines.toLocaleString('zh-CN')} 行` : ''}</span></span>
            <span className="attachment-kind">{previewTypeLabel(attachment.name)}</span>
            {openable && <span className="attachment-open-cue" aria-hidden="true"><PanelRightOpen /></span>}
          </div>;
        })}
      </div>}
      {text ? <UserText text={text} /> : null}
    </div>}
  </div>}
  {/* 用户消息同样在悬浮时显示复制、编辑与发送时间；复制时带上消息里的图片。 */}
  {!editing && <MessageActions
    text={readableComposerReferences(copyText)}
    images={messageImages}
    time={message.timestamp}
    label="复制消息"
    align="end"
    onEdit={canEdit ? beginEdit : undefined}
    editDisabled={editDisabled}
  />}
  </div>;
}

export const ChatMessageView = memo(ChatMessageViewComponent, (previous, next) =>
  previous.message === next.message
  && previous.id === next.id
  && previous.onOpenFile === next.onOpenFile
  && previous.onEdit === next.onEdit
  && previous.editDisabled === next.editDisabled);
