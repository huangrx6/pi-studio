import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { getActivePreferences } from '../preferences';

const components: Components = {
  a({ href, children, node: _node, ...props }) {
    return <a {...props} href={href} onClick={(event) => {
      if (!href || href.startsWith('#')) return;
      if (/^https?:\/\//i.test(href)) {
        event.preventDefault();
        void window.piApi.openLink(href, getActivePreferences().linkOpen);
      }
    }}>{children}</a>;
  },
};

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return <div className="markdown">
    <ReactMarkdown components={components} remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]} skipHtml>
      {children}
    </ReactMarkdown>
  </div>;
});
