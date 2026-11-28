import type { ExtensionSettingsPage } from './extension-types';

export type ToolWindowContext = {
  key: string;
  title: string;
  cwd?: string;
  sessionId?: string;
  workspaces?: Array<{ name: string; path: string }>;
};

export type ToolWindowRequest =
  | { kind: 'browser'; url?: string; library?: 'history' | 'downloads' }
  | { kind: 'terminal' }
  | { kind: 'extension'; panelId: string; title?: string };

export type ToolWindowAction =
  | { kind: 'file'; path: string }
  | { kind: 'prompt'; text: string; submit: boolean }
  | { kind: 'temporary'; options: { prompt?: string; title?: string; autoSubmit?: boolean } }
  | { kind: 'settings'; page: ExtensionSettingsPage };

export type ToolTab = {
  id: string;
  kind: ToolWindowRequest['kind'];
  title: string;
  url?: string;
  panelId?: string;
  loadGuest?: boolean;
  libraryRequest?: { id: string; view: 'history' | 'downloads' };
};

export type ToolWindowGroup = { mountId: string; context: ToolWindowContext; tabs: ToolTab[]; active: string };
export type ToolWindowState = { groups: ToolWindowGroup[]; key: string; visible: boolean; maximized: boolean };

export type ToolWindowDragHandle = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export type ToolWindowDrag = {
  phase: 'start' | 'update' | 'end' | 'cancel';
  handle: ToolWindowDragHandle;
  x: number;
  y: number;
};

export type ToolWindowCommand =
  | { kind: 'open'; request: ToolWindowRequest }
  | { kind: 'activate' | 'close' | 'restart'; id: string }
  | { kind: 'close-tabs'; ids: string[]; keepId?: string }
  | { kind: 'update'; id: string; title?: string; url?: string; acknowledged?: string }
  | { kind: 'action'; action: ToolWindowAction }
  | { kind: 'status-detail'; panelId: string }
  | { kind: 'start' | 'hide' | 'maximize' };
