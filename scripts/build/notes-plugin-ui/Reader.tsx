import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Braces, Check, Copy, ImageOff } from 'lucide-react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import katex from 'katex';
import { parse as parseYaml } from 'yaml';
import { htmlPreview } from './html-preview';
import { previewColor, type Scheme } from './appearance';
import { message, request, type Entry, type LocalAsset } from './bridge';
import 'katex/dist/katex.min.css';

export type Heading = { id: string; text: string; level: number };

type AstNode = { type: string; value?: string; children?: AstNode[]; data?: { hProperties: Record<string, string> } };
const WIKI = /\[\[([^|\]\r\n]+)(?:\|([^\]\r\n]+))?\]\]/g;
const IMAGE = /^data:image\/(?:png|gif|jpeg|webp|avif|svg\+xml)[;,]/i;
const MATH_SCOPE = { trust: false, maxExpand: 160, maxSize: 14, strict: 'ignore', throwOnError: false } as const;

function noteSyntax() {
  return (tree: AstNode) => {
    function visit(node: AstNode) {
      if (!node.children || ['link', 'linkReference', 'image', 'inlineCode', 'code'].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value?.includes('[[')) { visit(child); return [child]; }
        const text = child.value;
        const nodes: AstNode[] = [];
        let end = 0;
        for (const match of text.matchAll(WIKI)) {
          if (match.index > end) nodes.push({ type: 'text', value: text.slice(end, match.index) });
          const target = match[1].trim();
          nodes.push({ type: 'link', url: 'notes-wiki:' + encodeURIComponent(target),
            children: [{ type: 'text', value: match[2] || target }] } as AstNode);
          end = match.index + match[0].length;
        }
        if (end < text.length) nodes.push({ type: 'text', value: text.slice(end) });
        return nodes;
      });
      if (node.type !== 'blockquote') return;
      const first = node.children[0]?.children?.[0];
      const callout = first?.value?.match(/^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\][ \t]*(?:\r?\n)?/i);
      if (first && callout) {
        node.data = { hProperties: { 'data-callout': callout[1].toLowerCase() } };
        first.value = first.value?.slice(callout[0].length);
      }
    }
    visit(tree);
  };
}

function fields(text: string) {
  const match = text.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match || match[1].length > 16_000) return { body: text, properties: [] as Array<[string, string]> };
  try {
    const value = parseYaml(match[1], { maxAliasCount: 0 });
    const properties: Array<[string, string]> = [];
    for (const [key, label] of [['title', '标题'], ['created', '创建'], ['updated', '更新'], ['tags', '标签'], ['status', '状态']]) {
      const item = value?.[key];
      if (typeof item === 'string' || typeof item === 'number') properties.push([label, String(item)]);
      else if (Array.isArray(item) && item.every(tag => typeof tag === 'string') && item.length) properties.push([label, item.join(' · ')]);
    }
    return { body: text.slice(match[0].length), properties };
  } catch {
    return { body: text, properties: [] as Array<[string, string]> };
  }
}

function textOf(children: ReactNode): string {
  return Children.toArray(children).map(item => {
    if (isValidElement<{ children?: ReactNode }>(item)) return textOf(item.props.children);
    return typeof item === 'string' || typeof item === 'number' ? String(item) : '';
  }).join('');
}

function LocalImage({ from, src, alt, library }: { from: string; src?: string; alt?: string; library: string }) {
  const [loaded, setLoaded] = useState('');
  useEffect(() => {
    if (!src || IMAGE.test(src) || /^[a-z][a-z\d+.-]*:|^\//i.test(src)) return;
    let active = true;
    void request<LocalAsset>('asset', { from, href: src, library }).then(asset => {
      if (active) setLoaded(asset.dataUrl ?? '');
    }).catch(() => {});
    return () => { active = false; };
  }, [from, library, src]);
  const url = src && IMAGE.test(src) ? src : loaded;
  return url ? <img className="note-image" src={url} alt={alt || ''} loading="lazy" />
    : <span className="note-image-placeholder"><ImageOff size="calc(var(--icon-sm) + 1px)" />{alt || '图片暂不可预览'}</span>;
}

let diagramOrdinal = 0;
function Mermaid({ code, scheme }: { code: string; scheme: Scheme }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const source = code.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/%%\{[\s\S]*?\}%%/g, '');
    void (async () => {
      try {
        if (source.length > 40_000) throw new Error('图表过大');
        const { default: mermaid } = await import('mermaid');
        if (!active) return;
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', theme: scheme === 'dark' ? 'dark' : 'neutral',
          htmlLabels: false, maxTextSize: 40_000, maxEdges: 300, suppressErrorRendering: true,
        });
        const result = await mermaid.render('note-diagram-' + (++diagramOrdinal), source);
        if (active) setSvg('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(result.svg));
      } catch { if (active) setError(true); }
    })();
    return () => { active = false; };
  }, [code, scheme]);
  return svg ? <div className="note-diagram"><img src={svg} alt="Mermaid 图表" /></div>
    : error ? <details className="note-code"><summary>Mermaid 图表无法渲染，查看源码</summary><pre>{code}</pre></details>
      : <div className="note-rendering">正在渲染图表…</div>;
}

function CodeBox({ language, children }: { language: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    const input = document.createElement('textarea');
    input.value = textOf(children);
    input.className = 'clipboard-helper';
    document.body.append(input);
    input.select();
    const success = document.execCommand('copy');
    input.remove();
    if (success) setCopied(true);
  }
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(id);
  }, [copied]);
  return <div className="note-code" data-lang={language || undefined}>
    <div className="note-code-tools">
      {language && <span className="note-code-lang">{language}</span>}
      <button type="button" onClick={copy} aria-label={copied ? '已复制' : '复制代码'} title={copied ? '已复制' : '复制代码'}>
        {copied ? <Check size="calc(var(--icon-xs) + 1px)" /> : <Copy size="calc(var(--icon-xs) + 1px)" />}
      </button>
    </div>
    <pre>{children}</pre>
  </div>;
}

function markdownComponents({ from, library, scheme, onLink }: Pick<ReaderProps, 'from' | 'library' | 'scheme' | 'onLink'>): Components {
  return {
    a({ href, children }) {
      return <a href={href} onClick={event => { event.preventDefault(); if (href) onLink(href); }}>{children}</a>;
    },
    img({ src, alt }) {
      return <LocalImage key={src} src={src} alt={alt} library={library} from={from} />;
    },
    table({ children, node: _node, ...props }) {
      return <div className="note-table"><table {...props}>{children}</table></div>;
    },
    code({ className, children, node: _node, ...props }) {
      if (className?.includes('language-math')) {
        const block = className.includes('math-display');
        return <span className={block ? 'math-block' : 'math-inline'}
          dangerouslySetInnerHTML={{ __html: katex.renderToString(textOf(children), { ...MATH_SCOPE, displayMode: block }) }} />;
      }
      return <code className={className} {...props}>{children}</code>;
    },
    pre({ children, node }) {
      const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
      const language = code?.type === 'element'
        ? String(code.properties.className ?? '').match(/language-([\w+-]+)/)?.[1] ?? ''
        : '';
      if (language === 'mermaid') {
        const text = textOf(children);
        return <Mermaid key={text + scheme} code={text} scheme={scheme} />;
      }
      if (language === 'math') return <div className="note-math">{children}</div>;
      return <CodeBox language={language}>{children}</CodeBox>;
    },
  };
}

type ReaderProps = {
  from: string;
  text: string;
  scheme: Scheme;
  library: string;
  onLink: (href: string) => void;
  onHeadings: (headings: Heading[]) => void;
};

export function MarkdownReader({ from, text, scheme, library, onLink, onHeadings }: ReaderProps) {
  const ref = useRef<HTMLElement>(null);
  const { body, properties } = useMemo(() => fields(text), [text]);
  const components = useMemo(() => markdownComponents({ from, library, scheme, onLink }), [from, library, scheme, onLink]);
  useEffect(() => {
    const used = new Set<string>();
    const headings = [...ref.current!.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6')].map((element, index) => {
      const title = element.textContent?.trim() || '小节';
      const stem = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'heading';
      const id = used.has(stem) ? stem + '-' + (index + 1) : stem;
      used.add(id);
      element.id = id;
      return { id, text: title, level: Number(element.tagName[1]) };
    });
    onHeadings(headings);
  }, [body, onHeadings]);
  return <article className="markdown-note" ref={ref}>
    {properties.length > 0 && <details className="note-properties">
      <summary><Braces size="calc(var(--icon-xs) + 1px)" /> <span>笔记属性</span><span className="properties-count">{properties.length}</span></summary>
      <dl>{properties.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
    </details>}
    <Markdown skipHtml remarkPlugins={[remarkGfm, remarkMath, noteSyntax]}
      rehypePlugins={[[rehypeHighlight, { plainText: ['mermaid', 'math'] }]]}
      urlTransform={value => value.startsWith('notes-wiki:') || IMAGE.test(value) ? value : defaultUrlTransform(value)}
      components={components}>{body}</Markdown>
  </article>;
}

export function HtmlReader({ text, from, library, scheme, themeKey }: Pick<ReaderProps, 'text' | 'from' | 'library' | 'scheme'> & { themeKey: string }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      const colors = previewColor(document.querySelector('.knowledge-app') ?? document.documentElement, scheme);
      void htmlPreview(text, from, library, colors).then(result => {
        if (active) { setHtml(result); setError(''); }
      }).catch(reason => { if (active) setError(message(reason)); });
    }, 160);
    return () => { active = false; window.clearTimeout(timer); };
  }, [text, from, library, scheme, themeKey]);
  if (error) return <div className="error-strip" role="alert">{error}</div>;
  return html ? <iframe className="html-note" title="HTML 阅读预览" sandbox="" srcDoc={html} referrerPolicy="no-referrer" />
    : <div className="note-rendering">正在排版 HTML…</div>;
}

export function AttachmentReader({ entry, library, open }: { entry: Entry; library: string; open: () => void }) {
  const leaf = entry.name;
  return <div className="note-attachment">
    {entry.kind === 'image' && <LocalImage from={entry.path} src={encodeURIComponent(leaf)} alt={leaf} library={library} />}
    <span>{leaf}</span>
    <button className="secondary" type="button" onClick={open}>用系统应用打开</button>
  </div>;
}
