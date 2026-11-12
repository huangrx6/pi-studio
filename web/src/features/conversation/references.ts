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

/**
 * 引用前的占位空白。
 *
 * 输入框的高亮层与 textarea 必须逐字符对齐，图标只能在“本来就有空白”的位置
 * 显示；一个普通空格只有 4px，放不下图标。插入引用时改用 em space（1em 宽），
 * 高亮层把这段宽度画成图标，textarea 里它依然只是一个不可见的空白字符。
 */
export const REFERENCE_GAP = '\u2003';

/** 发送前把 em space 还原成普通空格，避免脏字符进入对话与模型输入。 */
export function normalizeComposerText(text: string): string {
  return text.includes(REFERENCE_GAP) ? text.replaceAll(REFERENCE_GAP, ' ') : text;
}

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
// 含空格、引号或 @ 的路径用 JSON 字符串包在 @ 后，避免路径在第一个空格处被截断。
// 标点一律算分隔符：`@README.md、@package.json` 里中文顿号属于正文，不是路径。
const AT_REFERENCE_SOURCE = String.raw`@(?:"(?:\\.|[^"\\])*"|[^\s@，。、；：！？,;:!?()\[\]{}（）【】「」『』]+)`;
// 未展开的行内引用：`/skill:name` 或 `@path`；允许出现在文本中间（前面需是行首或非单词字符）。
const INLINE_REF = new RegExp(
  String.raw`(^|[^A-Za-z0-9_])(\/skill:[\w.-]+|${AT_REFERENCE_SOURCE})`,
  'g',
);
// 发送时只提取真实路径并交给主进程读取文件上下文。前导边界与高亮一致：
// `看 @a、@b` 里的顿号后面同样是引用，而 email 里的 @ 前面是字母，不会被误判。
const INLINE_MENTION = new RegExp(String.raw`(?:^|[^A-Za-z0-9_])(${AT_REFERENCE_SOURCE})`, 'g');

/** 文件路径的短标签：取最后一段（目录保留尾部斜杠的语义）。 */
function fileLabel(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.split('/').pop() || trimmed;
}

function atReferencePath(token: string): string {
  const source = token.slice(1);
  if (!source.startsWith('"')) return source;
  try {
    const parsed: unknown = JSON.parse(source);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return source.slice(1, -1);
  }
}

function inlineReference(token: string): Reference {
  if (token.startsWith('/skill:')) {
    return { kind: 'skill', token, label: token.slice('/skill:'.length) };
  }
  const path = atReferencePath(token);
  return { kind: 'file', token, label: fileLabel(path), location: path };
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

/**
 * 输入框高亮的片段：普通文本或已识别的引用 token。
 *
 * token 带上解析后的 `reference`，渲染层才能按目标类型（目录、代码、图片…）
 * 选图标；`text` 始终是原文，输入框靠它和 textarea 逐字符对齐。
 */
export type ComposerSegment =
  | { kind: 'text'; text: string }
  | {
    kind: 'token';
    text: string;
    tokenKind: 'skill' | 'file' | 'command';
    reference?: Reference;
    /** token 前是 em space：有 1em 的空白可以画图标，而不是压住前一个字。 */
    gapBefore?: boolean;
    /** token 前是换行（或文本开头）：只能内缩，不能外扩。 */
    lineStart?: boolean;
  };

/** 把工作区路径格式化为输入框可识别、可安全包含空格的 @ 引用。 */
export function formatFileReference(path: string): string {
  return /[\s@"]/u.test(path) ? `@${JSON.stringify(path)}` : `@${path}`;
}

/** 从一段将要发送的文本中提取 @ 文件路径，供主进程注入文件上下文。 */
export function extractComposerMentions(text: string): string[] {
  return [...text.matchAll(INLINE_MENTION)].flatMap((match) => {
    const path = atReferencePath(match[1]);
    return path ? [path] : [];
  });
}

/**
 * Replace the active `/` or `@` query with a complete reference while keeping
 * it separated from adjacent prose. The leading marker remains in the raw
 * textarea value for command parsing and caret alignment; the renderer hides
 * only its visible glyph.
 */
export function insertComposerToken(
  text: string,
  start: number,
  end: number,
  token: string,
): { text: string; caret: number } {
  const safeStart = Math.max(0, Math.min(text.length, start));
  const safeEnd = Math.max(safeStart, Math.min(text.length, end));
  let before = text.slice(0, safeStart);
  const after = text.slice(safeEnd);
  // 文件引用前面放一个 em space：它既当分隔符，也给高亮层留出图标位置。
  // 前面已经有普通空格时直接把它换掉，避免两个空白叠在一起。
  let leading = safeStart > 0 && !/\s$/u.test(before) ? ' ' : '';
  if (token.startsWith('@') && safeStart > 0) {
    if (/[ \t]$/u.test(before)) before = before.slice(0, -1);
    leading = REFERENCE_GAP;
  }
  const trailing = /^\s/u.test(after) ? '' : ' ';
  const inserted = `${leading}${token}${trailing}`;
  return {
    text: `${before}${inserted}${after}`,
    caret: safeStart + inserted.length,
  };
}

/**
 * 输入框内联高亮：把技能 / 文件 / 已加载的命令标成彩色 token。
 * 只影响显示，textarea 的真实文本保持不变。
 *
 * @param text 输入框文本
 * @param commandNames 已加载的命令名（不含前导斜杠），用于识别 /new 这类命令
 */
export function splitComposerText(text: string, commandNames: ReadonlySet<string>): ComposerSegment[] {
  const segments: ComposerSegment[] = [];
  const pattern = new RegExp(
    String.raw`(^|[^A-Za-z0-9_])(\/[A-Za-z][\w:.-]*|${AT_REFERENCE_SOURCE})`,
    'g',
  );
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[1].length;
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) });
    const token = match[2];
    const name = token.slice(1);
    const gapBefore = start > 0 && text[start - 1] === REFERENCE_GAP;
    const lineStart = start === 0 || text[start - 1] === '\n';
    if (token.startsWith('@')) {
      segments.push({ kind: 'token', text: token, tokenKind: 'file', reference: inlineReference(token), gapBefore, lineStart });
    } else if (name.startsWith('skill:') || commandNames.has(name)) {
      segments.push({
        kind: 'token',
        text: token,
        tokenKind: name.startsWith('skill:') ? 'skill' : 'command',
        reference: name.startsWith('skill:') ? inlineReference(token) : undefined,
        gapBefore,
        lineStart,
      });
    } else {
      // 未识别的斜杠（常见于 /Users/... 这类路径）保持普通文本。
      segments.push({ kind: 'text', text: token });
    }
    last = start + token.length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}
