/**
 * 统一的 Markdown 渲染器：GFM 表格/任务列表 + 代码高亮。
 *
 * 关键行为：
 * - 禁用原始 HTML（skipHtml），对话内容来自模型，不能当作可信 HTML 执行；
 * - 链接点击不交给渲染进程导航，而是把 http(s) 链接交给主进程
 *   `piApi.openLink`，按偏好用系统浏览器或应用内窗口打开；
 * - 使用 memo + 模块级 components 配置，避免流式输出时反复重建渲染器。
 *
 * 本组件是纯渲染，不直接发 IPC；链接打开偏好从 preferences 的模块级缓存读取。
 */
import { memo, useContext } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { getActivePreferences } from './preferences';
import { safeMarkdownImageSource } from './safe-url.js';
import rehypeLocalPaths from './rehype-local-paths.mjs';
import { MarkdownActions } from './markdown-actions';
import { MarkdownPathLink } from './MarkdownPathLink';

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
 * rehypeHighlight 使用 detect + ignoreMissing，未标注语言的代码块也能尝试高亮，
 * 未知语言则静默跳过而不是报错。
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return <div className="markdown">
    <ReactMarkdown components={components} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeLocalPaths, [rehypeHighlight, { detect: true, ignoreMissing: true }]]} skipHtml>
      {children}
    </ReactMarkdown>
  </div>;
});
