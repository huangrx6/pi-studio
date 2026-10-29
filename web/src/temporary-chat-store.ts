import type { ChatMessage } from './chat-types';
import type { ModelSelection } from './model-types';
export type TemporaryImage = { id: string; name: string; data: string; mimeType: string };
export type TemporaryState = { messages: ChatMessage[]; draft: string; images: TemporaryImage[]; selection: ModelSelection; busy: boolean; error: string; run: number };
// Deliberately no localStorage, IndexedDB, attachment upload or session persistence.
const chats = new Map<string, TemporaryState>();
const listeners = new Map<string, Set<() => void>>();
let listening = false;
export function temporaryState(id: string, selection: ModelSelection) {
  if (!chats.has(id)) chats.set(id, { messages: [], draft: '', images: [], selection, busy: false, error: '', run: 0 });
  if (!listening) {
    listening = true;
    window.piApi.onTemporary(event => {
      const state = chats.get(event.id); if (!state || !event.message) return;
      const message = event.message;
      const messages = [...state.messages];
      let index = messages.findIndex(item => item.role === message.role && item.timestamp === message.timestamp);
      if (message.role === 'user' && index < 0) index = messages.findIndex(item => item.role === 'user' && (item.timestamp ?? 0) < 0);
      if (index < 0) messages.push(message); else messages[index] = message;
      updateTemporary(event.id, { messages });
    });
  }
  return chats.get(id)!;
}
export function peekTemporary(id: string) { return chats.get(id); }
export function subscribeTemporary(id: string, listener: () => void) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id)!.add(listener);
  return () => { listeners.get(id)?.delete(listener); };
}
export function updateTemporary(id: string, patch: Partial<TemporaryState>) {
  const current = chats.get(id); if (!current) return;
  chats.set(id, { ...current, ...patch }); listeners.get(id)?.forEach(listener => listener());
}
export function destroyTemporary(id: string) {
  chats.delete(id); listeners.delete(id); void window.piApi.temporaryClose(id).catch(() => {});
}
export async function sendTemporary(id: string) {
  const state = chats.get(id); if (!state || state.busy || (!state.draft.trim() && !state.images.length)) return;
  const run = state.run+1, stamp = -Date.now();
  const message: ChatMessage = { role: 'user', timestamp: stamp, content: [{ type: 'text', text: state.draft }, ...state.images.map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))] };
  updateTemporary(id, { busy: true, error: '', draft: '', images: [], run, messages: [...state.messages, message] });
  try { await window.piApi.temporaryPrompt({ id, text: state.draft, images: state.images, modelRef: state.selection.modelRef, thinkingLevel: state.selection.thinkingLevel }); }
  catch (error) {
    const current = chats.get(id); if (!current || current.run !== run) return;
    const accepted = !current.messages.some(item => item.timestamp === stamp);
    updateTemporary(id, { error: error instanceof Error ? error.message : String(error), ...(!accepted ? { messages: current.messages.filter(item => item.timestamp !== stamp), draft: current.draft || state.draft, images: current.images.length ? current.images : state.images } : {}) });
  } finally { if (chats.get(id)?.run === run) updateTemporary(id, { busy: false }); }
}
