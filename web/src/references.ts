/**
 * 消息与输入框里的「引用」解析。
 *
 * 两种来源：
 *  1. 技能命令：`/skill:deck-authoring ...`。
 *     Pi 在发送前会把它展开成 `<skill name="..." location="...">正文</skill>`，
 *     所以会话历史里读到的是展开后的块；气泡显示时再还原成一枚徽章 + 可折叠正文。
 *  2. 文件引用：`@src/App.tsx`，原样保留在文本里。
 *
 * 这里只做「文本 → 片段」的纯函数，不修改任何发送给模型的内容；
 * 输入框与消息气泡共用同一套解析，保证两处显示一致。
 */

export type ReferenceKind = 'skill' | 'file';

/** 一条可展示的引用（技能或工作区文件）。 */
export type Reference = {
  kind: ReferenceKind;
  /** 原文 token，用于从输入框移除。 */
  token: string;
  /** 徽章上显示的短名称。 */
  label: string;
  /** 技能定义文件或文件路径，作为 title。 */
  location?: string;
  /** 技能正文（仅消息气泡里的展开块有）。 */
  body?: string;
};

export type TextSegment = { kind: 'text'; text: string } | { kind: 'reference'; reference: Reference };

// 展开后的技能块：Pi 写成 <skill name="x" location="...">正文</skill>。
const SKILL_BLOCK = /<skill\s+name="([^"]+)"(?:\s+location="([^"]*)")?\s*>([\s\S]*?)<\/skill>/g;
// 未展开的行内引用：`/skill:name` 或 `@path`，允许出现在文本中间（前面需是行首或空白）。
const INLINE_REF = /(^|[^A-Za-z0-9_])(\/skill:[\w.-]+|@[^\s@]+)/g;

/** 文件路径的短标签：取最后一段（目录保留尾部斜杠的语义）。 */
function fileLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.split('/').pop() || trimmed;
}

function inlineReference(token: string): Reference {
  return token.startsWith('/skill:')
    ? { kind: 'skill', token, label: token.slice('/skill:'.length) }
    : { kind: 'file', token, label: fileLabel(token.slice(1)), location: token.slice(1) };
}

/** 把一段纯文本拆成「文本 + 行内引用」。 */
function pushInline(chunk: string, out: TextSegment[]): void {
  if (!chunk) return;
  let last = 0;
  for (const match of chunk.matchAll(INLINE_REF)) {
    const start = match.index + match[1].length;
    if (start > last) out.push({ kind: 'text', text: chunk.slice(last, start) });
    const token = match[2];
    out.push({ kind: 'reference', reference: inlineReference(token) });
    last = start + token.length;
  }
  if (last < chunk.length) out.push({ kind: 'text', text: chunk.slice(last) });
}

/**
 * 用于消息气泡：优先识别展开后的技能块，其余文本再识别 @ 文件与未展开技能。
 */
export function splitMessageText(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let index = 0;
  for (const match of text.matchAll(SKILL_BLOCK)) {
    pushInline(text.slice(index, match.index), segments);
    segments.push({
      kind: 'reference',
      reference: { kind: 'skill', token: match[0], label: match[1], location: match[2] || undefined, body: match[3].trim() },
    });
    index = match.index + match[0].length;
  }
  pushInline(text.slice(index), segments);
  return segments;
}

/** 输入框高亮的片段：普通文本或已识别的引用 token。 */
export type ComposerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'token'; text: string; tokenKind: 'skill' | 'file' | 'command' };

/**
 * 输入框内联高亮：把技能 / 文件 / 已加载的命令标成彩色 token。
 * 只影响显示，textarea 的真实文本保持不变。
 *
 * @param text 输入框文本
 * @param commandNames 已加载的命令名（不含前导斜杠），用于识别 /new 这类命令
 */
export function splitComposerText(text: string, commandNames: ReadonlySet<string>): ComposerSegment[] {
  const segments: ComposerSegment[] = [];
  const pattern = /(^|[^A-Za-z0-9_])(\/[A-Za-z][\w:.-]*|@[^\s@]+)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[1].length;
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) });
    const token = match[2];
    const name = token.slice(1);
    if (token.startsWith('@')) {
      segments.push({ kind: 'token', text: token, tokenKind: 'file' });
    } else if (name.startsWith('skill:') || commandNames.has(name)) {
      segments.push({ kind: 'token', text: token, tokenKind: name.startsWith('skill:') ? 'skill' : 'command' });
    } else {
      // 未识别的斜杠（常见于 /Users/... 这类路径）保持普通文本。
      segments.push({ kind: 'text', text: token });
    }
    last = start + token.length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}
