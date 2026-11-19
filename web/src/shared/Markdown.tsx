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
import { copyMarkdownSource } from './markdown-copy';
import { splitStreamingMarkdown, useStreamingMarkdownText } from './streaming-markdown-text';

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

type MarkdownProps = {
  children: string;
  codeChrome?: boolean;
  /** While true, parse updates are coalesced so long streaming answers stay smooth. */
  streaming?: boolean;
};

export const Markdown = memo(function Markdown({
  children,
  codeChrome = true,
  streaming = false,
}: MarkdownProps) {
  const text = useStreamingMarkdownText(children, streaming);
  const parts = streaming ? splitStreamingMarkdown(text) : null;
  const plain = (value: string, busy = false) => (
    <div className="markdown markdown-plain" aria-busy={busy || undefined} onCopy={(event) => copyMarkdownSource(event, value)}>{value}</div>
  );
  const render = (value: string, live: boolean) => (
    <MarkdownBoundary fallback={plain(value)}>
      <Suspense fallback={plain(value, true)}>
        <LazyMarkdownRenderer codeChrome={codeChrome} streaming={live}>{value}</LazyMarkdownRenderer>
      </Suspense>
    </MarkdownBoundary>
  );
  if (parts?.frozen) {
    return <>
      {render(parts.frozen, false)}
      {parts.live ? render(parts.live, true) : null}
    </>;
  }
  return render(text, streaming);
});
