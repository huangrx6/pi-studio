import type { ComposerCapability } from '../../types/chat-types';

type CapabilityType = Exclude<ComposerCapability['type'], 'mcp-server'>;

export type ComposerMenuState = {
  kind: 'slash' | 'file' | 'agent' | 'capability';
  query: string;
  start: number;
  end: number;
  capabilityType?: CapabilityType;
  mcpServer?: { id: string; name: string; parentQuery: string };
};

export type MentionCategory = 'file' | 'agent' | 'capability';

export const composerCapabilityCategories = [
  { type: 'skill', label: '技能' },
  { type: 'mcp', label: 'MCP' },
  { type: 'plugin', label: '插件' },
] as const satisfies readonly { type: CapabilityType; label: string }[];

export function composerMenuAt(value: string, caret: number, previous?: ComposerMenuState | null): ComposerMenuState | null {
  const before = value.slice(0, caret);
  const slash = before.match(/(?:^|\s)\/([^\s]*)$/u);
  if (slash) return { kind: 'slash', query: slash[1], start: caret - slash[1].length - 1, end: caret };
  const match = before.match(/(?:^|[^A-Za-z0-9_@"#$\\/\x60])([@#$])([^\s@#$"'()[\]{}\x60]*)$/u);
  if (!match) {
    // Keep a plugin's multi-word display name searchable while its picker is open.
    const query = previous?.kind === 'capability' && before[previous.start] === '$' ? before.slice(previous.start + 1) : '';
    return previous && /^[\p{L}\p{M}\p{N}._/-]+(?: [\p{L}\p{M}\p{N}._/-]*)+$/u.test(query)
      ? { ...previous, query, end: caret } : null;
  }
  const [, sigil, query] = match;
  if (sigil === '#' && /^\d/u.test(query)) return null;
  if (sigil === '$' && /^(?:\d|(?:HOME|PATH|PWD|SHELL|USER|LANG|[A-Z]+_[A-Z\d_]+)$)/u.test(query)) return null;
  const start = caret - query.length - 1;
  const kind = sigil === '@' ? 'file' : sigil === '#' ? 'agent' : 'capability';
  if (kind === 'capability' && previous?.kind === kind && previous.start === start) {
    return { ...previous, end: caret, query };
  }
  return { kind, start, end: caret, query };
}
