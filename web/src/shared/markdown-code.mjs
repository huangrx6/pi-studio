/**
 * Detect code inside Markdown source before paying for the syntax highlighter.
 * Fenced blocks cover normal model output; the indented branch preserves the
 * previous auto-detection behaviour for four-space and tab-indented code.
 */
const FENCED_CODE = /^(?: {0,3}>[ \t]?)*(?: {0,3})(?:`{3,}|~{3,})/m;
const INDENTED_CODE = /^(?: {0,3}>[ \t]?)*(?: {4}|\t)\S/m;

export function hasMarkdownCode(text) {
  return FENCED_CODE.test(text) || INDENTED_CODE.test(text);
}

/** Select prefetch work from the same renderable text paths that use Markdown. */
export function messagesHaveMarkdownCode(messages) {
  return messages.some((message) => message.content.some((block) =>
    (block.type === 'text' && hasMarkdownCode(block.text))
    || (block.type === 'thinking' && hasMarkdownCode(block.thinking))));
}
