import type { MarkdownHighlighterPlugin } from './markdown-highlighter';

export type { MarkdownHighlighterPlugin } from './markdown-highlighter';

let highlighterPromise: Promise<MarkdownHighlighterPlugin> | null = null;
let loadedHighlighter: MarkdownHighlighterPlugin | null = null;

export function loadMarkdownHighlighter(): Promise<MarkdownHighlighterPlugin> {
  if (loadedHighlighter) return Promise.resolve(loadedHighlighter);
  if (!highlighterPromise) {
    highlighterPromise = import('./markdown-highlighter').then((module) => {
      loadedHighlighter = module.markdownHighlighterPlugin;
      return loadedHighlighter;
    });
  }
  return highlighterPromise;
}

export function loadedMarkdownHighlighter(): MarkdownHighlighterPlugin | null {
  return loadedHighlighter;
}
