/**
 * Stable Markdown entry point backed by a deferred renderer chunk.
 *
 * The plain source is painted while the chunk loads, so a conversation keeps its
 * content and approximate height instead of showing an empty skeleton. If the
 * local chunk cannot load, the same readable plain text becomes the permanent
 * fallback without taking down the app shell or composer.
 */
import { Component, Suspense, lazy, memo, type ReactNode } from 'react';
import { loadMarkdownHighlighter } from './markdown-highlighter-loader';

export function preloadMarkdownRenderer() {
  return import('./MarkdownRenderer');
}

export function preloadMarkdownHighlighter() {
  return loadMarkdownHighlighter();
}

const LazyMarkdownRenderer = lazy(async () => {
  const module = await preloadMarkdownRenderer();
  return { default: module.MarkdownRenderer };
});

class MarkdownBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return <MarkdownBoundary fallback={
    <div className="markdown markdown-plain">{children}</div>
  }>
    <Suspense fallback={
      <div className="markdown markdown-plain" aria-busy="true">{children}</div>
    }>
      <LazyMarkdownRenderer>{children}</LazyMarkdownRenderer>
    </Suspense>
  </MarkdownBoundary>;
});
