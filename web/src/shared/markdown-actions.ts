/**
 * Host hooks for rendered markdown.
 *
 * The renderer stays shared: chat, subagent transcripts and temporary chats all
 * mount the same markdown component, so file and link behaviour is injected
 * once by the app shell instead of being threaded through every view.
 */
import { createContext, type ComponentType } from 'react';

export type MarkdownActionsValue = {
  /** Conversation working directory used to resolve relative paths. */
  cwd?: string;
  /** Open a local file preview in the right panel. */
  openFile?: (path: string) => void;
  /** Open a file reference from Markdown as an external/local preview. */
  openLocalFile?: (path: string) => void;
  /** Open an http(s) link (the in-app browser or the system browser). */
  openLink?: (url: string) => void;
};

export const MarkdownActions = createContext<MarkdownActionsValue>({});

// Only the conversation mounts this provider; file and settings previews retain their own image handling.
export const MarkdownImageRenderer = createContext<ComponentType<{ src: string; alt: string; cwd?: string; linked: boolean }> | null>(null);
