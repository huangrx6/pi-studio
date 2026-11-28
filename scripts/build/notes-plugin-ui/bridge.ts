import { useEffect, useState } from 'react';
import { applyStudioTheme } from '../../../sdk/extensions/view-theme.mjs';
import type { Appearance, Scheme } from './appearance';

export type Kind = 'folder' | 'markdown' | 'html' | 'image' | 'pdf';
export type Library = { id: string; name: string };
export type Section = { id: string; name: string };
export type Entry = { path: string; parent: string; name: string; kind: Kind; section?: string };
export type Tree = { entries: Entry[]; sections: Record<string, string>; partial: boolean };
export type Note = { path: string; format: 'markdown' | 'html'; text: string; revision: string; modifiedAt: string };
export type Search = { matches: Array<Entry & { excerpt: string }>; partial: boolean };
export type Save = { status: 'saved'; note: Note } | { status: 'conflict'; current: Note | null };
export type LocalAsset = { path: string; dataUrl?: string; css?: string };
type Snapshot = { library: Library | null; sections: Section[]; revision: number; appearance?: Appearance };

const PROTOCOL = 'pi-studio:ext-view:v1';
let nextRequest = 0;
const pending = new Map<string, (ok: boolean, value: unknown) => void>();

function post(type: string, fields?: Record<string, unknown>) {
  window.parent.postMessage({ protocol: PROTOCOL, type, ...fields }, '*');
}

export function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const requestId = 'notes-' + (++nextRequest);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('笔记操作超时，请重试。'));
    }, method === 'chooseDirectory' ? 180_000 : 45_000);
    pending.set(requestId, (ok, value) => {
      window.clearTimeout(timeout);
      if (ok) resolve(value as T);
      else reject(new Error(typeof value === 'string' ? value : '笔记操作未完成。'));
    });
    post('view:invoke', { requestId, method, params });
  });
}

export function useBridge() {
  const [state, setState] = useState({ loading: true, error: '', data: null as Snapshot | null });
  const [host, setHost] = useState({ scheme: 'dark' as Scheme, revision: 0 });
  useEffect(() => {
    function message(event: MessageEvent) {
      const data = event.data;
      if (event.source !== window.parent || data?.protocol !== PROTOCOL) return;
      if (data.type === 'host:context') {
        const scheme = applyStudioTheme(data);
        setHost(current => ({ scheme, revision: current.revision + 1 }));
      }
      if (data.type === 'host:snapshot') {
        setState({ loading: Boolean(data.loading), error: String(data.error ?? ''), data: data.data ?? null });
      }
      if (data.type === 'host:response') {
        const resolve = pending.get(data.requestId);
        pending.delete(data.requestId);
        resolve?.(data.ok === true, data.ok ? data.result : data.error);
      }
    }
    window.addEventListener('message', message);
    post('view:ready');
    return () => window.removeEventListener('message', message);
  }, []);
  return { ...state, host };
}

export function retry() { post('view:retry'); }

export function askAboutNote(path: string) {
  post('view:openTemporaryChat', {
    prompt: '$[plugin:studio.notes-library|知识库] 请读取笔记「' + path + '」，我想继续讨论它。',
    title: '笔记对话',
  });
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function label(name: string) {
  return name.replace(/\.(?:md|markdown|html?|pdf)$/i, '');
}

export function notePath(from: string, link: string) {
  if (!link || link.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(link)) return '';
  const parts = from.split('/').slice(0, -1);
  let decoded;
  try { decoded = decodeURIComponent(link); } catch { return ''; }
  for (const part of decoded.split('/')) {
    if (part === '..') {
      if (!parts.length) return '';
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
