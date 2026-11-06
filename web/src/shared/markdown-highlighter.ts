import rehypeHighlight from 'rehype-highlight';

/** Rehype plugin tuple loaded only after Markdown actually contains code. */
export type MarkdownHighlighterPlugin = [
  typeof rehypeHighlight,
  { detect: boolean; ignoreMissing: boolean },
];

export const markdownHighlighterPlugin: MarkdownHighlighterPlugin = [
  rehypeHighlight,
  { detect: true, ignoreMissing: true },
];
