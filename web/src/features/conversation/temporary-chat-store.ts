import type { ChatMessage } from '../../types/chat-types';
import { createEmptyModelSelection, type ModelSelection } from '../../types/model-types.ts';
import { errorText } from '../../shared/error-text.ts';
import { temporaryChatCanSubmit } from './temporary-chat-input.ts';

export type TemporaryImage = { id: string; name: string; data: string; mimeType: string };
export type TemporaryState = {
  messages: ChatMessage[];
  draft: string;
  images: TemporaryImage[];
  selection: ModelSelection;
  modelSettled: boolean;
  busy: boolean;
  error: string;
  run: number;
  autoSubmit?: boolean;
  historyStatus: 'loading' | 'failed' | 'ready';
};

const chats = new Map<string, TemporaryState>();
const listeners = new Map<string, Set<() => void>>();
const historyListeners = new Set<() => void>();
const pendingSeeds = new Map<string, { draft: string; autoSubmit: boolean }>();
const pendingHistory = new Set<string>();
const reading = new Map<string, symbol>();
const canvasChats = new Set<string>();
const releaseAfterReply = new Set<string>();
let listening = false;
let nextRun = 0;

export function seedTemporaryChat(id: string, draft: string, autoSubmit = false) {
  if (chats.has(id)) updateTemporary(id, { draft, autoSubmit });
  else pendingSeeds.set(id, { draft, autoSubmit });
}

export function prepareTemporaryHistory(id: string) {
  if (!chats.has(id)) pendingHistory.add(id);
}

export function subscribeTemporaryHistory(listener: () => void) {
  historyListeners.add(listener);
  return () => { historyListeners.delete(listener); };
}

function historyChanged() {
  historyListeners.forEach(listener => listener());
}

export function temporaryState(id: string, selection: ModelSelection) {
  if (!chats.has(id)) {
    const seed = pendingSeeds.get(id);
    pendingSeeds.delete(id);
    chats.set(id, {
      messages: [],
      draft: seed?.draft ?? '',
      images: [],
      selection,
      modelSettled: Boolean(selection.modelRef),
      busy: false,
      error: '',
      run: 0,
      autoSubmit: seed?.autoSubmit ?? false,
      historyStatus: pendingHistory.delete(id) ? 'loading' : 'ready',
    });
  }
  if (!listening) {
    listening = true;
    window.piApi.onTemporary(event => {
      if (event.type === 'done') {
        historyChanged();
        return;
      }
      if (event.type === 'message' && event.message?.role === 'user') historyChanged();
      const state = chats.get(event.id);
      if (!state) return;
      if (event.type === 'error') {
        updateTemporary(event.id, { error: event.message || '临时回复未完成' });
        return;
      }
      const message = event.message;
      if (!message) return;
      const messages = [...state.messages];
      let index = messages.findIndex(item => item.role === message.role && item.timestamp === message.timestamp);
      if (message.role === 'user' && index < 0) index = messages.findIndex(item => item.role === 'user' && (item.timestamp ?? 0) < 0);
      if (index < 0) messages.push(message);
      else messages[index] = message;
      updateTemporary(event.id, { messages });
    });
  }
  return chats.get(id)!;
}

export async function loadTemporaryRecord(id: string) {
  if (reading.has(id) || chats.get(id)?.historyStatus !== 'loading') return;
  const token = Symbol();
  reading.set(id, token);
  try {
    const record = await window.piApi.temporaryRead(id);
    if (!record) throw new Error('找不到这条临时对话。');
    let selection: ModelSelection;
    try {
      selection = await window.piApi.temporaryModel({ modelRef: record.modelRef, thinkingLevel: record.thinkingLevel });
    } catch (error) {
      selection = { ...createEmptyModelSelection(), modelRef: record.modelRef, label: record.modelRef,
        thinkingLevel: record.thinkingLevel, unavailable: true, unavailableReason: errorText(error) };
    }
    if (reading.get(id) === token) updateTemporary(id, { messages: record.messages, selection, modelSettled: true, historyStatus: 'ready', error: '' });
  } catch (error) {
    if (reading.get(id) === token) updateTemporary(id, { historyStatus: 'failed', modelSettled: true, error: errorText(error) });
  } finally {
    if (reading.get(id) === token) reading.delete(id);
  }
}

export function peekTemporary(id: string) { return chats.get(id); }
export function subscribeTemporary(id: string, listener: () => void) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id)!.add(listener);
  return () => {
    const current = listeners.get(id);
    current?.delete(listener);
    if (!current?.size) listeners.delete(id);
  };
}
export function updateTemporary(id: string, patch: Partial<TemporaryState>) {
  const current = chats.get(id);
  if (!current) return;
  chats.set(id, { ...current, ...patch });
  listeners.get(id)?.forEach(listener => listener());
}

function releaseTemporary(id: string) {
  reading.delete(id);
  pendingSeeds.delete(id);
  pendingHistory.delete(id);
  releaseAfterReply.delete(id);
  if (chats.delete(id)) void window.piApi.temporaryClose(id).catch(() => {});
}

function leaveCanvas(id: string) {
  if (canvasChats.has(id)) return;
  const state = chats.get(id);
  if (state?.busy) releaseAfterReply.add(id);
  else if (!state?.draft && !state?.images.length) releaseTemporary(id);
}

export function retainTemporaryCanvas(id: string) {
  canvasChats.add(id);
  releaseAfterReply.delete(id);
  return () => {
    canvasChats.delete(id);
    // React can reattach the same surface within this commit.
    queueMicrotask(() => leaveCanvas(id));
  };
}

export async function sendTemporary(id: string) {
  const state = chats.get(id);
  if (!state || state.historyStatus !== 'ready' || !temporaryChatCanSubmit({
    draft: state.draft,
    imageCount: state.images.length,
    modelRef: state.selection.modelRef,
    unavailable: state.selection.unavailable,
    busy: state.busy,
  })) return;
  const run = ++nextRun;
  const stamp = -Date.now();
  const message: ChatMessage = { role: 'user', timestamp: stamp, content: [{ type: 'text', text: state.draft }, ...state.images.map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))] };
  updateTemporary(id, { busy: true, error: '', draft: '', images: [], run, messages: [...state.messages, message] });
  try {
    await window.piApi.temporaryPrompt({ id, text: state.draft, images: state.images, modelRef: state.selection.modelRef, thinkingLevel: state.selection.thinkingLevel });
  } catch (error) {
    const current = chats.get(id);
    if (!current || current.run !== run) return;
    const accepted = !current.messages.some(item => item.timestamp === stamp);
    updateTemporary(id, { error: errorText(error), ...(!accepted ? { messages: current.messages.filter(item => item.timestamp !== stamp), draft: current.draft || state.draft, images: current.images.length ? current.images : state.images } : {}) });
  } finally {
    if (chats.get(id)?.run === run) {
      updateTemporary(id, { busy: false });
      if (releaseAfterReply.delete(id)) leaveCanvas(id);
    }
    historyChanged();
  }
}
