/**
 * Markdown 的实际渲染器：GFM 表格/任务列表，并按需加载代码高亮。
 *
 * 这个模块由 `Markdown.tsx` 按需加载；语法高亮器只在源码实际包含代码块时
 * 再加载。安全边界与链接行为仍由这个单一实现负责。
 */
import { memo, useContext, useEffect, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getActivePreferences } from './preferences';
import { safeMarkdownImageSource } from './safe-url.js';
import rehypeLocalPaths from './rehype-local-paths.mjs';
import { MarkdownActions } from './markdown-actions';
import { MarkdownPathLink } from './MarkdownPathLink';
import { hasMarkdownCode } from './markdown-code.mjs';
import {
  loadMarkdownHighlighter,
  loadedMarkdownHighlighter,
  type MarkdownHighlighterPlugin,
} from './markdown-highlighter-loader';

/**
 * 自定义渲染规则。放在模块作用域：ReactMarkdown 每次 render 都新建
 * components 会导致所有节点重挂载，流式输出时会明显掉帧。
 */
const components: Components = {
  a({ href, children, node, ...props }) {
    const actions = useContext(MarkdownActions);
    // Local paths detected by rehypeLocalPaths carry dataPath instead of a URL.
    const dataPath = (node?.properties as Record<string, unknown> | undefined)?.dataPath;
    if (typeof dataPath === 'string') {
      return <MarkdownPathLink path={dataPath}>{children}</MarkdownPathLink>;
    }
    // node 是 react-markdown 的 AST 节点；解构出来是为了避免它被 ...props 透传到 DOM。
    return <a {...props} href={href} onClick={(event) => {
      // 页内锚点与无链接不拦截，保持默认滚动行为。
      if (!href || href.startsWith('#')) return;
      // 先统一阻止默认导航：这是 Electron 窗口，相对链接或 file: 链接
      // 会把整个渲染进程导航走，模型输出又不可信，不能交给浏览器处理。
      event.preventDefault();
      // http(s) 优先交给宿主：有内嵌浏览器面板时开在侧边栏，否则回落到
      // 主进程按偏好打开系统浏览器或应用内窗口。
      if (/^https?:\/\//i.test(href)) {
        if (actions.openLink) actions.openLink(href);
        else void window.piApi.openLink(href, getActivePreferences().linkOpen);
      }
    }}>{children}</a>;
  },
  img({ src, alt, node: _node, ...props }) {
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
export const MarkdownRenderer = memo(function MarkdownRenderer({ children }: { children: string }) {
  const [highlighter, setHighlighter] = useState<MarkdownHighlighterPlugin | null>(loadedMarkdownHighlighter);
  const [highlighterStatus, setHighlighterStatus] = useState<'idle' | 'loading' | 'failed'>('idle');

  useEffect(() => {
    if (highlighter || highlighterStatus !== 'idle' || !hasMarkdownCode(children)) return;
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
  }, [children, highlighter, highlighterStatus]);

  const rehypePlugins = highlighter
    ? [rehypeLocalPaths, highlighter]
    : [rehypeLocalPaths];

  return <div className="markdown">
    <ReactMarkdown components={components} remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} skipHtml>
      {children}
    </ReactMarkdown>
  </div>;
});
