import type { ConversationSummary } from './durable-types';

export type WorkspaceTree = {
  projectRoot: string;
  branch: string;
  main: boolean;
  detached: boolean;
};

export type PiWorkspace = {
  cwd: string;
  name: string;
  sessions: ConversationSummary[];
  rooms?: { id: string; name: string }[];
  worktree?: WorkspaceTree;
  missing?: boolean;
  sessionCount?: number;
  archivedCount?: number;
};

export type FileSearchOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  include?: string;
  exclude?: string;
};
export type FileContentMatches = {
  path: string;
  count: number;
  rows: Array<{ line: number; parts: Array<{ text: string; match?: boolean }> }>;
};
export type FileContentResults = { files: FileContentMatches[]; count: number; truncated: boolean };

export type CodeLocation = { path: string; line: number; column: number; endLine?: number; endColumn?: number };
export type CodeQuery = {
  cwd: string; path: string; kind: 'definition' | 'references' | 'tokens';
  line?: number; column?: number; drafts: { path: string; text: string }[];
};
export type CodeQueryResult = { locations?: CodeLocation[]; tokens?: number[] };
