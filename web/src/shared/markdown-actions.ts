/**
 * Host hooks for rendered markdown.
 *
 * The renderer stays shared: chat, subagent transcripts and temporary chats all
 * mount the same markdown component, so file and link behaviour is injected
 * once by the app shell instead of being threaded through every view.
 */
import { createContext } from 'react';

export type MarkdownActionsValue = {
  /** Conversation working directory used to resolve relative paths. */
  cwd?: string;
  /** Open a local file preview in the right panel. */
  openFile?: (path: string) => void;
  /** Open an http(s) link (the in-app browser or the system browser). */
  openLink?: (url: string) => void;
};

export const MarkdownActions = createContext<MarkdownActionsValue>({});
