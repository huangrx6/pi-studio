/**
 * Markdown 的实际渲染器：GFM 表格/任务列表，并按需加载代码高亮。
 *
 * 这个模块由 `Markdown.tsx` 按需加载；语法高亮器只在源码实际包含代码块时
 * 再加载。安全边界与链接行为仍由这个单一实现负责。
 */
import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { safeMarkdownImageSource } from './safe-url.ts';
import rehypeLocalPaths from './rehype-local-paths.ts';
import { MarkdownActions, MarkdownImageRenderer } from './markdown-actions';
import { MarkdownPathLink } from './MarkdownPathLink';
import { localHrefPath, resolvePathToken } from './file-path-links.ts';
import { hasMarkdownCode } from './markdown-code.ts';
import { copyMarkdownSource } from './markdown-copy';
import {
  loadMarkdownHighlighter,
  loadedMarkdownHighlighter,
  type MarkdownHighlighterPlugin,
} from './markdown-highlighter-loader';

/** Stable plugin lists — ReactMarkdown re-parses the tree when these array identities change. */
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_REHYPE_BASE = [rehypeLocalPaths];

/**
 * 代码块外壳：语言标签 + 复制。文件源码视图会关闭这层 chrome，保留同一套
 * Markdown/高亮解析，但把代码直接铺在编辑器式的内容面上。
 *
 * 代码块本身仍由 `<pre><code>` 承担，这里只加一层 chrome；语言从
 * rehype 挂在 code 上的 `language-*` class 里取，取不到就不显示标签。
 */
function MarkdownCodeBlock({ language, children }: { language: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return <div className="markdown-code">
    <div className="markdown-code-bar">
      <span className="markdown-code-language">{language || 'text'}</span>
      <button
        type="button"
        className={`markdown-code-copy${copied ? ' is-copied' : ''}`}
        aria-label={copied ? '已复制' : '复制代码'}
        title={copied ? '已复制' : '复制代码'}
        onClick={(event) => {
          const text = event.currentTarget.closest('.markdown-code')?.querySelector('pre')?.textContent ?? '';
          void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false));
        }}
      >{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button>
    </div>
    {children}
  </div>;
}

function markdownUrl(url: string, key: string) {
  if (key === 'src') {
    if (/^data:image\//i.test(url)) return safeMarkdownImageSource(url);
    // Local workspace images are resolved by the conversation's preview component.
    if (/^[a-z]:[\\/]/i.test(url)) return url;
  }
  return defaultUrlTransform(url);
}

const InsideMarkdownLink = createContext(false);
const MarkdownCodeChromeContext = createContext(true);

const MarkdownPre: NonNullable<Components['pre']> = ({ node, children, ...props }) => {
  const codeChrome = useContext(MarkdownCodeChromeContext);
  const code = node?.children?.find((child) => child.type === 'element' && child.tagName === 'code');
  const className = (code && 'properties' in code ? code.properties?.className : undefined) as string[] | undefined;
  const language = (className ?? []).find((name) => name.startsWith('language-'))?.slice('language-'.length) ?? '';
  const pre = <pre {...props}>{children}</pre>;
  return codeChrome ? <MarkdownCodeBlock language={language}>{pre}</MarkdownCodeBlock> : <pre {...props} className="markdown-source-pre">{children}</pre>;
};

/**
 * 自定义渲染规则。放在模块作用域：ReactMarkdown 每次 render 都新建
 * components 会导致所有节点重挂载，流式输出时会明显掉帧。
 */
const components: Components = {
  table({ node, children, ...props }) {
    return <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="表格">
      <table {...props}>{children}</table>
    </div>;
  },
  a({ href, children, node, ...props }) {
    const actions = useContext(MarkdownActions);
    const content = <InsideMarkdownLink.Provider value>{children}</InsideMarkdownLink.Provider>;
    // Local paths detected by rehypeLocalPaths carry dataPath instead of a URL.
    const dataPath = (node?.properties as Record<string, unknown> | undefined)?.dataPath;
    if (typeof dataPath === 'string') {
      return <MarkdownPathLink path={dataPath}>{content}</MarkdownPathLink>;
    }
    const localPath = localHrefPath(href || '');
    const localTarget = localPath ? resolvePathToken(localPath, actions.cwd) : null;
    // node 是 react-markdown 的 AST 节点；解构出来是为了避免它被 ...props 透传到 DOM。
    return <a {...props} href={href} onClick={(event) => {
      // 页内锚点与无链接不拦截，保持默认滚动行为。
      if (!href || href.startsWith('#')) return;
      // 先统一阻止默认导航：这是 Electron 窗口，相对链接或 file: 链接
      // 会把整个渲染进程导航走，模型输出又不可信，不能交给浏览器处理。
      event.preventDefault();
      if (localTarget) {
        (actions.openLocalFile || actions.openFile)?.(localTarget);
        return;
      }
      // http(s)：宿主 openLink 走浏览器设置（工作台/系统）；无宿主时回落系统浏览器。
      if (/^https?:\/\//i.test(href)) {
        if (actions.openLink) actions.openLink(href);
        else void window.piApi.openLink(href, 'external');
      }
    }}>{content}</a>;
  },
  pre: MarkdownPre,
  img({ src, alt, node: _node, ...props }) {
    const Renderer = useContext(MarkdownImageRenderer);
    const { cwd } = useContext(MarkdownActions);
    const linked = useContext(InsideMarkdownLink);
    if (Renderer && src) return <Renderer key={`${cwd || ''}\0${src}`} src={src} alt={alt || ''} cwd={cwd} linked={linked} />;
    const safeSrc = safeMarkdownImageSource(src);
    if (!safeSrc) return null;
    return <img {...props} src={safeSrc} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" />;
  },
};

/**
 * Markdown 渲染组件。
 *
 * @param children Markdown 源文本（流式输出时会被高频替换）
 *
 * memo 的比较对象是字符串 children，内容不变时跳过重渲染；
 * 正文会先以无高亮但完整可读的形式渲染。检测到代码块后才加载
 * rehypeHighlight；未标注语言仍会自动检测，未知语言静默跳过。
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  children,
  codeChrome = true,
  streaming = false,
}: {
  children: string;
  codeChrome?: boolean;
  /** Live turns skip syntax highlighting until the answer settles. */
  streaming?: boolean;
}) {
  const [highlighter, setHighlighter] = useState<MarkdownHighlighterPlugin | null>(loadedMarkdownHighlighter);
  const [highlighterStatus, setHighlighterStatus] = useState<'idle' | 'loading' | 'failed'>('idle');

  useEffect(() => {
    // Highlighting is deferred until the turn finishes so streaming tokens only
    // pay for GFM parse, not a second rehype pass that rebuilds every code node.
    if (streaming || highlighter || highlighterStatus !== 'idle' || !hasMarkdownCode(children)) return;
    setHighlighterStatus('loading');
    void loadMarkdownHighlighter()
      .then((plugin) => {
        setHighlighter(plugin);
        setHighlighterStatus('idle');
      })
      .catch(() => {
        // Plain Markdown remains readable when the optional chunk is unavailable.
        setHighlighterStatus('failed');
      });
  }, [children, highlighter, highlighterStatus, streaming]);

  const rehypePlugins = useMemo(
    () => (highlighter ? [...MARKDOWN_REHYPE_BASE, highlighter] : MARKDOWN_REHYPE_BASE),
    [highlighter],
  );

  return <MarkdownCodeChromeContext.Provider value={codeChrome}>
    <div className="markdown" onCopy={(event) => copyMarkdownSource(event, children)}>
      <ReactMarkdown urlTransform={markdownUrl} components={components} remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={rehypePlugins} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  </MarkdownCodeChromeContext.Provider>;
});
