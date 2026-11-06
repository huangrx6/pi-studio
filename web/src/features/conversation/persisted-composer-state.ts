import type {
  ChatAttachment,
  ChatMessage,
  ComposerAttachment,
} from '../../types/chat-types';
import type {
  ComposerDraft,
  ComposerDraftStore,
} from './composer-drafts';
import type {
  PreparedSubmission,
  QueuedPrompt,
} from './composer-types';

const DATABASE_NAME = 'pi-studio-composer-state';
const DATABASE_VERSION = 1;
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'current';

const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_DRAFTS = 128;
const MAX_QUEUE_SESSIONS = 64;
const MAX_QUEUE_ITEMS = 100;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 512;
const MAX_PATH_CHARS = 4_096;
const MAX_MIME_CHARS = 256;
const MAX_ATTACHMENTS = 8;
const MAX_MENTIONS = 256;
const MAX_ATTACHMENT_BYTES = 20_000_000;
const MAX_IMAGE_BASE64_CHARS = 16_000_000;

type PersistedSubmission = {
  requestId: string;
  displayText: string;
  outgoingText: string;
  persistentAttachments: ChatAttachment[];
  mentions: string[];
};

export type PersistedDraft = {
  key: string;
  text: string;
  attachments: ComposerAttachment[];
  updatedAt: number;
};

export type PersistedQueuedPrompt = {
  id: string;
  order: number;
  text: string;
  attachments: ComposerAttachment[];
  submission: PersistedSubmission;
};

export type PersistedQueue = {
  sessionId: string;
  items: PersistedQueuedPrompt[];
  updatedAt: number;
};

export type PersistedComposerInputState = {
  version: 1;
  activeDraftKey: string;
  drafts: PersistedDraft[];
  queues: PersistedQueue[];
};

export type RestoredComposerInputState = {
  activeDraftKey: string;
  drafts: ComposerDraftStore;
  queues: Record<string, QueuedPrompt[]>;
};

export const RESTORED_QUEUE_NOTICE = '上次退出前未发送；确认后再发送。';

function safeString(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit) return '';
  return value;
}

function safeIdentifier(value: unknown): string {
  const id = safeString(value, MAX_ID_CHARS).trim();
  return id && !RESERVED_KEYS.has(id) ? id : '';
}

function safeWorkspacePath(value: unknown): string {
  const workspace = safeString(value, MAX_PATH_CHARS).trim();
  const absolute = workspace.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(workspace)
    || workspace.startsWith('\\\\');
  return absolute && !RESERVED_KEYS.has(workspace) ? workspace : '';
}

function safeDraftKey(value: unknown): string {
  const key = safeString(value, MAX_PATH_CHARS + MAX_ID_CHARS).trim();
  if (key.startsWith('session:')) {
    return safeIdentifier(key.slice('session:'.length))
      ? key
      : '';
  }
  if (key.startsWith('new:')) {
    return safeWorkspacePath(key.slice('new:'.length)) ? key : '';
  }
  return '';
}

function safeTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizeAttachment(value: unknown): ComposerAttachment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<ComposerAttachment>;
  const id = safeIdentifier(item.id);
  const kind = item.kind;
  const name = safeString(item.name, MAX_NAME_CHARS).trim();
  const mime = safeString(item.mime, MAX_MIME_CHARS).trim();
  const bytes = item.bytes;
  if (
    !id
    || (kind !== 'image' && kind !== 'file')
    || !name
    || !mime
    || typeof bytes !== 'number'
    || !Number.isFinite(bytes)
    || bytes < 0
    || bytes > MAX_ATTACHMENT_BYTES
  ) return undefined;

  if (kind === 'image') {
    const data = safeString(item.data, MAX_IMAGE_BASE64_CHARS);
    if (!data) return undefined;
    return { id, kind, name, mime, bytes, data };
  }

  const path = safeWorkspacePath(item.path);
  if (!path) return undefined;
  const lines = typeof item.lines === 'number' && Number.isFinite(item.lines) && item.lines >= 0
    ? Math.floor(item.lines)
    : 0;
  const marker = safeString(item.marker, MAX_PATH_CHARS).trim();
  return {
    id,
    kind,
    name,
    mime,
    bytes,
    path,
    lines,
    ...(marker ? { marker } : {}),
  };
}

function normalizeAttachments(value: unknown): ComposerAttachment[] {
  if (!Array.isArray(value)) return [];
  const output: ComposerAttachment[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (output.length >= MAX_ATTACHMENTS) break;
    const attachment = normalizeAttachment(candidate);
    if (!attachment || ids.has(attachment.id)) continue;
    ids.add(attachment.id);
    output.push(attachment);
  }
  return output;
}

function normalizeChatAttachment(value: unknown): ChatAttachment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<ChatAttachment>;
  const name = safeString(item.name, MAX_NAME_CHARS).trim();
  const path = safeWorkspacePath(item.path);
  const bytes = item.bytes;
  if (
    !name
    || !path
    || typeof bytes !== 'number'
    || !Number.isFinite(bytes)
    || bytes < 0
    || bytes > MAX_ATTACHMENT_BYTES
  ) return undefined;
  const lines = typeof item.lines === 'number' && Number.isFinite(item.lines) && item.lines >= 0
    ? Math.floor(item.lines)
    : 0;
  const mime = safeString(item.mime, MAX_MIME_CHARS).trim();
  return {
    name,
    path,
    bytes,
    lines,
    kind: item.kind === 'text' ? 'text' : 'file',
    ...(mime ? { mime } : {}),
  };
}

function normalizePersistentAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  const output: ChatAttachment[] = [];
  const paths = new Set<string>();
  for (const candidate of value) {
    if (output.length >= MAX_ATTACHMENTS) break;
    const attachment = normalizeChatAttachment(candidate);
    if (!attachment || paths.has(attachment.path)) continue;
    paths.add(attachment.path);
    output.push(attachment);
  }
  return output;
}

function normalizeMentions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (output.length >= MAX_MENTIONS) break;
    const mention = safeString(candidate, MAX_PATH_CHARS).trim();
    if (!mention || seen.has(mention)) continue;
    seen.add(mention);
    output.push(mention);
  }
  return output;
}

function normalizeDraft(value: unknown): PersistedDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<PersistedDraft>;
  const key = safeDraftKey(item.key);
  const text = safeString(item.text, MAX_TEXT_CHARS);
  const attachments = normalizeAttachments(item.attachments);
  if (!key || (!text && attachments.length === 0)) return undefined;
  return {
    key,
    text,
    attachments,
    updatedAt: safeTimestamp(item.updatedAt),
  };
}

function reconstructSubmission(
  sessionId: string,
  value: unknown,
  attachments: ComposerAttachment[],
): PreparedSubmission | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<PersistedSubmission>;
  const requestId = safeIdentifier(item.requestId);
  const displayText = safeString(item.displayText, MAX_TEXT_CHARS);
  const outgoingText = safeString(item.outgoingText, MAX_TEXT_CHARS);
  const persistentAttachments = normalizePersistentAttachments(item.persistentAttachments);
  const mentions = normalizeMentions(item.mentions);
  if (!requestId || (!displayText && !outgoingText && attachments.length === 0)) return undefined;

  const imagePayload = attachments.flatMap((attachment) => (
    attachment.kind === 'image' && attachment.data
      ? [{ type: 'image' as const, data: attachment.data, mimeType: attachment.mime }]
      : []
  ));
  const content: ChatMessage['content'] = [];
  if (displayText) content.push({ type: 'text', text: displayText });
  for (const image of imagePayload) {
    content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  }
  return {
    sessionId,
    requestId,
    displayText,
    outgoingText,
    content,
    persistentAttachments,
    imagePayload,
    mentions,
    attachmentPaths: persistentAttachments.map((attachment) => attachment.path),
  };
}

function normalizeQueuedPrompt(
  sessionId: string,
  value: unknown,
  index: number,
): QueuedPrompt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<PersistedQueuedPrompt>;
  const id = safeIdentifier(item.id);
  const text = safeString(item.text, MAX_TEXT_CHARS);
  const attachments = normalizeAttachments(item.attachments);
  const submission = reconstructSubmission(sessionId, item.submission, attachments);
  if (!id || !submission) return undefined;
  const order = typeof item.order === 'number' && Number.isFinite(item.order)
    ? Math.max(1, Math.floor(item.order))
    : index + 1;
  return { id, order, text, attachments, submission };
}

function normalizeQueue(value: unknown): PersistedQueue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<PersistedQueue>;
  const sessionId = safeIdentifier(item.sessionId);
  if (!sessionId || !Array.isArray(item.items)) return undefined;
  const items: PersistedQueuedPrompt[] = [];
  const ids = new Set<string>();
  const requestIds = new Set<string>();
  for (const [index, candidate] of item.items.entries()) {
    if (items.length >= MAX_QUEUE_ITEMS) break;
    const queued = normalizeQueuedPrompt(sessionId, candidate, index);
    if (!queued || ids.has(queued.id) || requestIds.has(queued.submission.requestId)) continue;
    ids.add(queued.id);
    requestIds.add(queued.submission.requestId);
    items.push({
      id: queued.id,
      order: queued.order,
      text: queued.text,
      attachments: queued.attachments,
      submission: {
        requestId: queued.submission.requestId,
        displayText: queued.submission.displayText,
        outgoingText: queued.submission.outgoingText,
        persistentAttachments: queued.submission.persistentAttachments,
        mentions: queued.submission.mentions,
      },
    });
  }
  if (items.length === 0) return undefined;
  return {
    sessionId,
    items: items
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((queued, index) => ({ ...queued, order: index + 1 })),
    updatedAt: safeTimestamp(item.updatedAt),
  };
}

function normalizeSnapshot(value: unknown): PersistedComposerInputState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { version: 1, activeDraftKey: '', drafts: [], queues: [] };
  }
  const input = value as Partial<PersistedComposerInputState>;
  if (input.version !== 1) {
    return { version: 1, activeDraftKey: '', drafts: [], queues: [] };
  }

  const drafts: PersistedDraft[] = [];
  const draftKeys = new Set<string>();
  for (const candidate of (Array.isArray(input.drafts) ? input.drafts : [])
    .sort((left, right) => safeTimestamp(right?.updatedAt) - safeTimestamp(left?.updatedAt))) {
    if (drafts.length >= MAX_DRAFTS) break;
    const draft = normalizeDraft(candidate);
    if (!draft || draftKeys.has(draft.key)) continue;
    draftKeys.add(draft.key);
    drafts.push(draft);
  }

  const queues: PersistedQueue[] = [];
  const sessionIds = new Set<string>();
  for (const candidate of (Array.isArray(input.queues) ? input.queues : [])
    .sort((left, right) => safeTimestamp(right?.updatedAt) - safeTimestamp(left?.updatedAt))) {
    if (queues.length >= MAX_QUEUE_SESSIONS) break;
    const queue = normalizeQueue(candidate);
    if (!queue || sessionIds.has(queue.sessionId)) continue;
    sessionIds.add(queue.sessionId);
    queues.push(queue);
  }
  return {
    version: 1,
    activeDraftKey: safeDraftKey(input.activeDraftKey),
    drafts,
    queues,
  };
}

export function restoreComposerInputState(value: unknown): RestoredComposerInputState {
  const normalized = normalizeSnapshot(value);
  const drafts: ComposerDraftStore = new Map();
  for (const draft of normalized.drafts) {
    drafts.set(draft.key, {
      text: draft.text,
      attachments: [...draft.attachments],
    });
  }
  const queues: Record<string, QueuedPrompt[]> = {};
  for (const queue of normalized.queues) {
    const items: QueuedPrompt[] = [];
    for (const item of queue.items) {
      const restored = normalizeQueuedPrompt(queue.sessionId, item, items.length);
      if (restored) items.push({ ...restored, autoRetryError: RESTORED_QUEUE_NOTICE });
    }
    if (items.length > 0) queues[queue.sessionId] = items;
  }
  return {
    activeDraftKey: normalized.activeDraftKey,
    drafts,
    queues,
  };
}

export function buildPersistedComposerInputState(
  drafts: ComposerDraftStore,
  queues: Record<string, QueuedPrompt[]>,
  activeDraftKey = '',
  now = Date.now(),
): PersistedComposerInputState {
  const savedDrafts: PersistedDraft[] = [];
  for (const [key, draft] of drafts) {
    const normalized = normalizeDraft({
      key,
      text: draft.text,
      attachments: [...draft.attachments],
      updatedAt: now,
    });
    if (normalized) savedDrafts.push(normalized);
  }
  const savedQueues: PersistedQueue[] = [];
  for (const [sessionId, items] of Object.entries(queues)) {
    const normalized = normalizeQueue({
      sessionId,
      updatedAt: now,
      items: items.map((item, index) => ({
        id: item.id,
        order: item.order || index + 1,
        text: item.text,
        attachments: item.attachments,
        submission: {
          requestId: item.submission.requestId,
          displayText: item.submission.displayText,
          outgoingText: item.submission.outgoingText,
          persistentAttachments: item.submission.persistentAttachments,
          mentions: item.submission.mentions,
        },
      })),
    });
    if (normalized) savedQueues.push(normalized);
  }
  return normalizeSnapshot({
    version: 1,
    activeDraftKey,
    drafts: savedDrafts,
    queues: savedQueues,
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onerror = () => reject(request.error || new Error('无法打开本地输入状态'));
    request.onblocked = () => reject(new Error('本地输入状态正在升级，请稍后重试'));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('本地输入状态写入失败'));
    transaction.onabort = () => reject(transaction.error || new Error('本地输入状态写入已取消'));
  });
}

export async function loadPersistedComposerInputState(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<RestoredComposerInputState> {
  if (!factory) return restoreComposerInputState(undefined);
  const database = await openDatabase(factory);
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const completed = transactionComplete(transaction);
    const request = transaction.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
    const [value] = await Promise.all([
      new Promise<unknown>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('本地输入状态读取失败'));
      }),
      completed,
    ]);
    return restoreComposerInputState(value);
  } finally {
    database.close();
  }
}

export async function savePersistedComposerInputState(
  value: PersistedComposerInputState,
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  if (!factory) throw new Error('当前环境无法保存本地输入状态');
  const database = await openDatabase(factory);
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(normalizeSnapshot(value), SNAPSHOT_KEY);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}
