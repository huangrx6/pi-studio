/**
 * Release notes 的结构化解析。
 *
 * 更新器已经在上层把 HTML 降级成纯文本（`electron/update-state.cjs`），这里只负责
 * 认回 markdown 的三种骨架——小节标题、列表项、段落——再把行内的粗体与代码标出来。
 * 渲染由 React 元素完成，任何标签都当普通文本转义，不会执行。
 */

export type ReleaseNoteBlock =
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'list'; items: string[] }
  | { kind: 'paragraph'; text: string };

export type ReleaseNoteToken = { kind: 'text' | 'strong' | 'code'; text: string };

const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;
const RULE = /^(?:[-*_]\s*){3,}$/;
const HEADING = /^#{1,6}\s+(.*)$/;
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/** 折叠阈值：按估算行数计（列表项各算一行），避免长 changelog 把对话框撑满。 */
export const RELEASE_NOTES_FOLD_LINES = 9;

export function parseReleaseNotes(text?: string): ReleaseNoteBlock[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const blocks: ReleaseNoteBlock[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  const flushList = () => {
    if (!items.length) return;
    blocks.push({ kind: 'list', items: [...items] });
    items = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || RULE.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = (line.match(/^#+/)?.[0].length ?? 1);
      const value = heading[1].replace(/#+\s*$/, '').trim();
      // 一级标题通常是「Pi Studio v0.0.15」这种版本名，标题栏已经表达过，跳过。
      if (value && level > 1) blocks.push({ kind: 'heading', text: value, level });
      continue;
    }
    if (LIST_MARKER.test(line)) {
      flushParagraph();
      items.push(line.replace(LIST_MARKER, '').trim());
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** 把 `**加粗**` 与 `` `代码` `` 拆成 token，其余内容原样保留。 */
export function parseReleaseNoteInline(text: string): ReleaseNoteToken[] {
  if (!text) return [];
  const tokens: ReleaseNoteToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > cursor) tokens.push({ kind: 'text', text: text.slice(cursor, index) });
    const value = match[0];
    tokens.push(value.startsWith('**')
      ? { kind: 'strong', text: value.slice(2, -2) }
      : { kind: 'code', text: value.slice(1, -1) });
    cursor = index + value.length;
  }
  if (cursor < text.length) tokens.push({ kind: 'text', text: text.slice(cursor) });
  return tokens;
}

export function countReleaseNoteLines(blocks: ReleaseNoteBlock[]): number {
  return blocks.reduce((total, block) => total + (block.kind === 'list' ? block.items.length : 1), 0);
}

export function shouldFoldReleaseNotes(blocks: ReleaseNoteBlock[]): boolean {
  return countReleaseNoteLines(blocks) > RELEASE_NOTES_FOLD_LINES;
}
