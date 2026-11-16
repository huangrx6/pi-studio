/**
 * 对话消息渲染：用户消息气泡与助手一轮回复。
 *
 * 两个导出：
 * - ChatMessageView：单条 user 消息（正文、附件卡片、内联图片）；
 * - AssistantTurnView：一轮助手输出。App 会把连续的 assistant 消息合并成一轮，
 *   toolResult 消息通过 toolResults（toolCallId → 消息）配对进对应工具调用。
 *
 * 一轮内部的「轨迹 / 回复」分区：
 * 轨迹按请求与正文边界分段；中间说明与最终回答始终独立显示。
 *
 * 展开状态：默认由偏好 stepDisplay（精简/标准/详细）和 stepCollapse
 * （回答结束后/保持展开/手动）决定；用户手动 toggle 会立即更新本地状态，
 * 流式增量保留手动选择；自动策略仅在整轮运行边界或配置改变时应用。
 *
 * IPC：本组件不直接调用 IPC，消息来自 App 的 Durable 会话快照与事件流；
 * 图片以 data URI 内联渲染，不再额外请求主进程。
 */
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CircleAlert, CircleX, Copy, FileText, Image as ImageIcon, List, PanelRightOpen, Pencil, Search, Sparkles, Terminal, Wrench } from 'lucide-react';
import { LoadingIndicator } from '../../shared/LoadingState';
import type { ChatMessage, ContentBlock, RequestTrace, ToolCallBlock, TurnDiff, TurnDiffFile } from '../../types/chat-types';
import type { StepCollapse, StepDisplay } from '../../shared/preferences';
import { AttachmentIcon } from '../../shared/AttachmentIcon';
import { previewTypeLabel } from '../../shared/file-preview.ts';
import { ConversationImageGallery, type ConversationImage } from './ConversationImageGallery';
import { isNearBottom, resolveLiveFollow } from './chat-scroll.ts';
import { messageClipboardHtml } from './message-copy';
import { MarkdownImageRenderer } from '../../shared/markdown-actions';
import { ConversationMarkdownImage } from './ConversationMarkdownImage';
import { Markdown } from '../../shared/Markdown';
import { collectFileChanges } from './file-changes';
import { WebSources } from './WebSources';
import { webSources, type WebSource } from './web-sources';
import { ActivitySummary, activityKind, type ActivityEntry } from './ActivitySummary';
import { FileChangeSummary } from './FileChangeSummary';
import { splitMessageText, type Reference } from './references';
import { ReferenceChip } from './ReferenceChip';
import './styles/execution-trace.css';
import { ConversationError } from './ConversationError';
import { isComposingKey } from '../../shared/keyboard-navigation';

/** 拼出消息里的全部文本块（用换行分隔）；用户正文和工具结果共用这一逻辑。 */
function textBlocks(blocks: ContentBlock[]): string {
  return blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
}

function imagesFromBlocks(blocks: ContentBlock[]): ConversationImage[] {
  return blocks.flatMap((block): ConversationImage[] => block.type === 'image'
    ? [{ src: `data:${block.mimeType};base64,${block.data}` }]
    : []);
}

/**
 * 内联图片列表。
 * 只取 image 块，base64 数据直接拼成 data URI；没有任何图片时不占位。
 *
 * @param blocks 消息内容块（用户消息或工具结果都可能带图片）
 */
function MessageImages({ blocks }: { blocks: ContentBlock[] }) {
  const images = imagesFromBlocks(blocks);
  if (images.length === 0) return null;
  return <ConversationImageGallery className="message-images" images={images} />;
}

/** 字节数转可读体积；附件卡片用，保留一位小数。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * 从工具参数里挑一段最能说明意图的文本作为摘要。
 *
 * 不同工具的参数名不一致（bash 用 command、read/edit 用 path、grep 用 pattern），
 * 因此按常见程度排序逐个尝试；字符串压平空白并截到 105 字符，
 * 数组参数拼成一行，避免摘要撑高标题行。
 */
function toolSummary(call: ToolCallBlock): string {
  const args = call.arguments ?? {};
  const values = [args.command, args.path, args.file_path, args.query, args.pattern, args.url, args.name, args.description];
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').slice(0, 105);
    if (Array.isArray(value) && value.length > 0) return value.map(String).join(' ').replace(/\s+/g, ' ').slice(0, 105);
  }
  return '';
}

/** 按工具名映射图标；未知工具统一用扳手，保证每条轨迹都有视觉标识。 */
function ToolIcon({ name }: { name: string }) {
  if (name === 'bash' || name === 'powershell') return <Terminal />;
  if (name === 'read') return <FileText />;
  if (name === 'grep' || name === 'find' || name === 'ls') return <Search />;
  if (name === 'edit' || name === 'write') return <Pencil />;
  return <Wrench />;
}

/** 毫秒时间戳格式化为 24 小时制 HH:mm；无时间戳时返回空串。 */
function formatTime(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** 拍平后的内容块；key 由「消息序号-块序号」组成，流式追加时保持稳定。 */
type FlatBlock = { block: ContentBlock; key: string };

/**
 * 单条工具调用（使用原生 <details> 折叠）。
 *
 * 三态由「是否拿到 result」和「是否出错」推导：
 * - 无结果 = 运行中（仅会话 busy 时转圈，非忙碌时显示静态图标）；
 * - 有结果且 isError = 失败；
 * - 有结果且无错误 = 完成。
 * 参数与结果都放在折叠体里，避免长输出占满对话区域。
 *
 * @param call 工具调用块
 * @param result 已配对的 toolResult 消息（可能尚未到达）
 * @param busy 当前会话是否仍在运行，控制加载图标动画
 */
function ActivityTool({ call, result, busy, defaultOpen = false, onOpenFile }: { call: ToolCallBlock; result?: ChatMessage; busy: boolean; defaultOpen?: boolean; onOpenFile?: (path: string) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const failed = Boolean(result?.isError);
  const done = Boolean(result);
  const summary = toolSummary(call);
  // read/edit/write 的参数就是真实路径：直接可点，不依赖对消息文本的猜测。
  const openablePath = typeof call.arguments?.path === 'string' && (call.name === 'read' || call.name === 'edit' || call.name === 'write')
    ? call.arguments.path
    : undefined;
  // Closed rows need only their summary; large outputs are joined on demand.
  const resultText = open && result ? textBlocks(result.content) : '';
  return <details
    className={`activity-tool activity-disclosure ${failed ? 'is-error' : ''} ${done ? 'is-done' : busy ? 'is-running' : 'is-incomplete'}`}
    open={open}
    onToggle={(event) => setOpen(event.currentTarget.open)}
  >
    <summary className="activity-disclosure-summary" aria-description={done && !failed ? '已完成' : undefined}>
      <span className="activity-tool-icon activity-disclosure-icon"><ToolIcon name={call.name} /></span>
      <span className="activity-tool-name activity-disclosure-title" title={call.name}>{call.name}</span>
      {summary && (openablePath && onOpenFile
        ? <button
          type="button"
          className="activity-tool-summary activity-disclosure-preview is-openable"
          title={`在右侧面板打开 ${openablePath}`}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onOpenFile(openablePath); }}
        >{summary}</button>
        : <span className="activity-tool-summary activity-disclosure-preview">{summary}</span>)}
      {(!done || failed) && <span className="activity-tool-status">{failed ? <><CircleX />失败</> : busy ? <><LoadingIndicator />执行中</> : <><CircleAlert />未完成</>}</span>}
      <ChevronDown className="activity-tool-chevron activity-disclosure-chevron" />
    </summary>
    {open && <div className="activity-tool-body activity-disclosure-body">
      <div className="activity-tool-label">参数</div>
      <pre className="activity-tool-code">{JSON.stringify(call.arguments, null, 2)}</pre>
      {result && <>
        {resultText && <><div className="activity-tool-label">结果</div>
          <pre className={`activity-tool-code ${failed ? 'is-error' : ''}`}>{resultText}</pre></>}
      </>}
    </div>}
  </details>;
}

/** 图片属于工具产物，与参数详情分别折叠；预览仅浏览当前步骤的图片。 */
function ToolResultImages({ callId, images }: { callId: string; images: ConversationImage[] }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return <div className="tool-result-images" data-tool-call-id={callId}>
    <button type="button" className="tool-result-images-toggle" aria-expanded={open}
      aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
      <span className="tool-result-images-icon activity-disclosure-icon" aria-hidden="true"><ImageIcon /></span><span className="tool-result-images-label">图像结果</span><span className="tool-result-images-count">{images.length}</span>
      <ChevronDown className={open ? 'is-open' : ''} />
    </button>
    <div id={bodyId} hidden={!open}>
      <ConversationImageGallery images={images} />
    </div>
  </div>;
}

/**
 * 思考过程折叠块。
 * redacted 时服务端没有返回正文，只显示占位文案；预览压平空白并截断，
 * 展开后才渲染完整 Markdown，避免闭合状态下也做高开销的解析。
 */
function ActivityThinking({ block, defaultOpen = false }: { block: Extract<ContentBlock, { type: 'thinking' }>; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const preview = block.redacted ? '思考内容已隐藏' : block.thinking.replace(/\s+/g, ' ').trim().slice(0, 110);
  return <details
    className="activity-thinking activity-disclosure"
    aria-label="查看决策过程"
    open={open}
    onToggle={(event) => setOpen(event.currentTarget.open)}
  >
    <summary className="activity-disclosure-summary">
      <span className="activity-thinking-icon activity-disclosure-icon" aria-hidden="true"><Sparkles /></span>
      <span className="activity-thinking-label activity-disclosure-title">决策</span>
      {!open && preview && <span className="activity-thinking-preview activity-disclosure-preview">{preview}</span>}
      <ChevronDown className="activity-thinking-chevron activity-disclosure-chevron" />
    </summary>
    {open && !block.redacted && block.thinking && <div className="activity-thinking-body activity-disclosure-body"><Markdown>{block.thinking}</Markdown></div>}
  </details>;
}

/**
 * 正在推理的思考行。与「决策」行共用同一套行结构（图标 | 标题 | 预览 | 状态 | 箭头），
 * 状态位换成转圈；正文随流式增量更新。
 *
 * 跟随策略：只有读者还贴在正文底部时才自动显示最新增量。一旦上滚（或拖滚动条
 * 离开底部），后续 token 不得再把视线拽回底部——之前的实现每个增量都强制
 * scrollTop = scrollHeight，导致「想上读就来回跳动」。
 */
function LiveThinking({ block }: { block: Extract<ContentBlock, { type: 'thinking' }> }) {
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const node = body.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [block.thinking]);
  return <div className="activity-thinking is-live activity-disclosure" aria-busy="true">
    <div className="activity-disclosure-summary">
      <span className="activity-thinking-icon activity-disclosure-icon" aria-hidden="true"><Sparkles /></span>
      <span className="activity-thinking-label activity-disclosure-title">思考中</span>
      <span className="activity-thinking-preview activity-disclosure-preview">推理中</span>
      <LoadingIndicator className="activity-thinking-spinner" />
    </div>
    <div
      ref={body}
      className="activity-thinking-body activity-disclosure-body"
      onWheel={(event) => {
        if (event.deltaY < 0) following.current = resolveLiveFollow({ wheelUp: true });
      }}
      onTouchMove={() => { following.current = false; }}
      onScroll={(event) => {
        following.current = resolveLiveFollow({ nearBottom: isNearBottom(event.currentTarget) });
      }}
    >
      {block.redacted ? <p className="activity-thinking-note">模型未提供推理正文。</p> : <Markdown>{block.thinking}</Markdown>}
    </div>
  </div>;
}

/** History retains the actual failure without repeating labels or suggesting an automatic replay. */
function AssistantError({ message }: { message: string }) {
  return <ConversationError className="assistant-error" message={message} announce={false} />;
}

/**
 * 助手一轮回复。
 *
 * @param messages 同一轮的连续 assistant 消息（App 已合并）
 * @param toolResults toolCallId → toolResult 消息，用于给工具调用补结果
 * @param busy 当前会话是否在运行
 * @param id 锚点 id，供右侧大纲跳转
 * @param retry 自动重试信息；存在时即使没有 streaming 也视为运行中
 * @param stepDisplay 轨迹展示密度（compact / standard / detailed）
 * @param stepCollapse 回答结束后的收起策略
 * @param showCodeView 是否在本轮结束后展示成功修改的文件摘要
 *
 * live 由 App 传入的本轮运行状态决定，工具调用间隙也保持运行中。failed 只在非 live 时成立，避免把可恢复的重试中间态显示成最终失败。
 */
/** 写入剪贴板；Clipboard API 不可用时退回 execCommand。 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 富文本剪贴板：正文 + 内联图片；主进程不可用时退回纯文本。 */
async function writeRichClipboard(text: string, html: string): Promise<boolean> {
  try {
    await window.piApi.copyRichText({ text, html });
    return true;
  } catch {
    return writeClipboard(text);
  }
}

/** 复制按钮：点击后短暂切换成对勾，避免额外弹提示。 */
function CopyButton({ text, images, label }: { text: string; images?: readonly string[]; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  async function copy() {
    const html = images && images.length > 0 ? messageClipboardHtml({ text, images }) : '';
    if (!text.trim() && !html) return;
    if (!(html ? await writeRichClipboard(text, html) : await writeClipboard(text))) return;
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }
  return <button
    type="button"
    className={`message-action ${copied ? 'is-copied' : ''}`}
    aria-label={copied ? '已复制' : label}
    title={copied ? '已复制' : label}
    onClick={() => void copy()}
  >{copied ? <Check /> : <Copy />}</button>;
}

/** 消息下方的悬浮操作行：复制、编辑与时间；没有内容时整行隐藏。 */
function MessageActions({ text, images, time, label, align = 'start', onEdit, editDisabled = false }: {
  text: string;
  images?: readonly string[];
  time?: number;
  label: string;
  align?: 'start' | 'end';
  onEdit?: () => void;
  editDisabled?: boolean;
}) {
  const hasImages = Boolean(images && images.length > 0);
  if (!text.trim() && !hasImages && !time) return null;
  return <div className={`message-actions is-${align}`}>
    {(text.trim() || hasImages) && <CopyButton text={text} images={images} label={label} />}
    {onEdit && <button
      type="button"
      className="message-action"
      aria-label="编辑消息"
      title={editDisabled ? '回答结束后可编辑消息' : '编辑消息'}
      disabled={editDisabled}
      onClick={onEdit}
    ><Pencil /></button>}
    {time ? <time className="message-action-time">{formatTime(time)}</time> : null}
  </div>;
}

/** 一段连续的执行记录。所有行共用一个网格，运行中的行与已完成的行逐列对齐。 */
function ActivitySequence({ entries, results, stepDisplay, onOpenFile }: {
  entries: ActivityEntry[];
  results: Map<string, ChatMessage>;
  stepDisplay: StepDisplay;
  onOpenFile?: (path: string) => void;
}) {
  const defaultOpen = stepDisplay === 'detailed';
  return <section className="activity-sequence" aria-label="本轮执行步骤">
    {entries.map(entry => <div className={`activity-sequence-item is-${entry.kind}`} key={entry.key}>
      {entry.kind === 'tool' && <ActivityTool
        call={entry.call}
        result={results.get(entry.call.id)}
        busy={Boolean(entry.live)}
        defaultOpen={defaultOpen || Boolean(results.get(entry.call.id)?.isError)}
        onOpenFile={onOpenFile}
      />}
      {entry.kind === 'thinking' && (entry.live
        ? <LiveThinking block={entry.block} />
        : <ActivityThinking block={entry.block} defaultOpen={defaultOpen} />)}
    </div>)}
  </section>;
}

/** 折叠策略只在整轮运行边界或配置变化时应用，流式增量不覆盖手动操作。 */
function TurnTrace({ live, active, policy, summary, errors, incomplete, sources, fetched, images, children }: {
  live: boolean; active: boolean; policy: StepCollapse; summary: React.ReactNode; errors: number;
  incomplete: number; sources?: WebSource[]; fetched?: boolean; images?: React.ReactNode; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(policy !== 'after-answer' || live);
  // Defer historical trace contents until first opened. Keep visited children
  // mounted so closing the group never resets their individual disclosure state.
  const [visited, setVisited] = useState(open);
  const bodyId = useId();
  useEffect(() => { if (open) setVisited(true); }, [open]);
  useEffect(() => {
    if (policy === 'after-answer') setOpen(live);
    else if (policy === 'keep-open') setOpen(true);
  }, [live, policy]);
  const status = <>
    {errors > 0 && <span className="turn-trace-errors">{errors > 1 ? `${errors} 项失败` : '失败'}</span>}
    {incomplete > 0 && <span className="turn-trace-incomplete">未完成</span>}
    {active && <span className="inline-activity-running"><LoadingIndicator />执行中</span>}
  </>;
  const toggle = { 'aria-expanded': open, 'aria-controls': bodyId, onClick: () => setOpen(value => !value) };
  return <section className={`turn-trace ${open ? 'is-open' : ''}`} aria-label="执行轨迹">
    {sources?.length ? <WebSources sources={sources} fetched={Boolean(fetched)} status={status}
      tools={<button type="button" className="web-source-details" aria-label="工具详情" title="工具详情" {...toggle}><List /></button>} />
      : <button type="button" className="turn-trace-toggle" {...toggle}>
        {summary}{status}<ChevronDown className="turn-trace-chevron" aria-hidden="true" />
      </button>}
    <div id={bodyId} hidden={!open} className="turn-trace-body">
      {(open || visited) && children}
    </div>
    {images}
  </section>;
}

type AssistantTurnViewProps = {
  messages: ChatMessage[];
  toolResults: Map<string, ChatMessage>;
  requestTraces?: RequestTrace[];
  busy: boolean;
  id?: string;
  turnError?: string;
  retry?: { attempt: number; maxAttempts: number; errorMessage?: string };
  stepDisplay?: StepDisplay;
  stepCollapse?: StepCollapse;
  showCodeView?: boolean;
  cwd?: string;
  /** 本轮 Git 快照；比工具参数更完整，包含 bash/脚本产生的改动。 */
  gitDiff?: TurnDiff;
  onUndo?: (at: number) => Promise<void>;
  onOpenDiff?: (file: TurnDiffFile | undefined, turn: TurnDiff) => void;
  onOpenFile?: (path: string) => void;
};

function AssistantTurnViewComponent({ messages, toolResults, requestTraces = [], busy, id, turnError, retry, stepDisplay = 'standard', stepCollapse = 'after-answer', showCodeView = false, cwd, gitDiff, onUndo, onOpenDiff, onOpenFile }: AssistantTurnViewProps) {
  const live = Boolean(retry) || busy;
  // 只看本轮最后一条助手消息：压缩/重试产生的中间失败不应盖住后面的成功输出。
  const lastMessage = messages[messages.length - 1];
  const error = !live ? turnError || lastMessage?.errorMessage : undefined;
  const interrupted = Boolean(error && /aborted/i.test(error));
  const failed = Boolean(error) && !interrupted;
  // 把本轮所有消息的内容块拍平；key 用「消息序号-块序号」，流式追加时不会错位。
  const flat: FlatBlock[] = messages.flatMap((message, messageIndex) => message.content.map((block, blockIndex) => ({
    block,
    key: `${messageIndex}-${blockIndex}`,
  })));
  // 最后一次操作仅用于确定“复制回答”的范围；视觉分组在下方按正文边界处理。
  let lastActivity = -1;
  flat.forEach((entry, index) => { if (entry.block.type === 'thinking' || entry.block.type === 'toolCall') lastActivity = index; });
  const responseBlocks = flat.slice(lastActivity + 1);
  const latest = messages.at(-1);
  const lastBlock = [...flat].reverse().find(entry => entry.block.type !== 'text' || entry.block.text.trim());
  type Segment = { key: string } & (
    | { kind: 'activity'; entries: ActivityEntry[] }
    | { kind: 'text'; text: string }
    | { kind: 'images'; images: ConversationImage[] }
  );
  const segments: Segment[] = [];
  let activeTool = false;
  for (const { block, key } of flat) {
    const tail = segments.at(-1);
    if (block.type === 'text') {
      if (block.text.trim()) segments.push({ key, kind: 'text', text: block.text });
    } else if (block.type === 'image') {
      const image = { src: `data:${block.mimeType};base64,${block.data}` };
      if (tail?.kind === 'images') tail.images.push(image);
      else segments.push({ key, kind: 'images', images: [image] });
    } else if (block.type === 'toolCall' || block.type === 'thinking') {
      const entry: ActivityEntry = block.type === 'toolCall'
        ? { key, kind: 'tool', call: block, live: live && !toolResults.has(block.id) }
        : { key, kind: 'thinking', block, live: live && key === lastBlock?.key };
      if (entry.live && entry.kind === 'tool') activeTool = true;
      const kind = activityKind(entry);
      if (tail?.kind === 'activity' && ['explore', 'write', 'edit', 'search', 'fetch'].includes(kind)
        && activityKind(tail.entries[0]) === kind) tail.entries.push(entry);
      else segments.push({ key, kind: 'activity', entries: [entry] });
    }
  }
  const phase = retry ? `正在重试 ${retry.attempt}/${retry.maxAttempts}`
    : activeTool ? '正在执行'
      : lastBlock?.block.type === 'thinking' ? '正在思考'
        : latest?.streaming && lastBlock?.block.type === 'text' ? '正在回复'
          : requestTraces.length > 0 ? '正在请求模型'
            : '正在继续处理';

  const codeFiles = showCodeView && !live ? collectFileChanges(messages, toolResults, cwd) : [];
  const turnDiff = showCodeView && !live ? gitDiff : undefined;
  // 复制只包含最终回复的文本块，不包含思考与工具调用。
  const answerText = responseBlocks
    .filter((entry) => entry.block.type === 'text')
    .map((entry) => entry.block.type === 'text' ? entry.block.text : '')
    .join('\n\n')
    .trim();
  return <div id={id} className={`assistant-turn ${live ? 'is-live' : ''} ${retry ? 'is-retrying' : ''} ${failed ? 'has-error' : ''} is-steps-${stepDisplay}`}>
    <div className="assistant-turn-rail"><span className="assistant-orb">π</span></div>
    <div className="assistant-turn-main">
      {/* 头部状态只在整轮结束后变为已完成，工具之间的等待仍是运行中。 */}
      <div className="assistant-turn-head">
        <span className="assistant-turn-name">Pi</span>
        <span className="assistant-turn-status" title={retry?.errorMessage}>{retry ? `重试中 ${retry.attempt}/${retry.maxAttempts}` : interrupted ? '已中断' : failed ? '失败' : live ? phase : '已完成'}</span>
        {latest?.timestamp && <time>{formatTime(latest.timestamp)}</time>}
      </div>
      {segments.map(segment => {
        if (segment.kind === 'text') return <div className="assistant-response" key={segment.key}><MarkdownImageRenderer.Provider value={ConversationMarkdownImage}><Markdown>{segment.text}</Markdown></MarkdownImageRenderer.Provider></div>;
        if (segment.kind === 'images') return <ConversationImageGallery key={segment.key} images={segment.images} />;
        const { entries } = segment;
        const kind = activityKind(entries[0]);
        const calls = entries.flatMap(entry => entry.kind === 'tool' ? [entry.call] : []);
        const sites = kind === 'search' || kind === 'fetch' ? webSources(calls, toolResults) : undefined;
        return <TurnTrace key={segment.key} live={live} active={entries.some(entry => entry.live)} policy={stepCollapse}
          sources={sites} fetched={kind === 'fetch'} images={calls.map(call => {
            const result = toolResults.get(call.id);
            const images = result && imagesFromBlocks(result.content);
            return images?.length ? <ToolResultImages key={call.id} callId={call.id} images={images} /> : null;
          })}
          summary={<ActivitySummary entries={entries} results={toolResults} />}
          errors={entries.filter(entry => entry.kind === 'tool' && toolResults.get(entry.call.id)?.isError).length}
          incomplete={entries.filter(entry => entry.kind === 'tool' && !entry.live && !toolResults.has(entry.call.id)).length}>
          <ActivitySequence entries={entries} results={toolResults} stepDisplay={stepDisplay} onOpenFile={onOpenFile} />
        </TurnTrace>;
      })}
      {/* 失败卡片只在非 live 时出现，避免自动重试过程中闪错误。 */}
      {!live && error && (interrupted
        ? <div className="assistant-interrupted" role="status">本轮已中断</div>
        : <AssistantError message={error} />)}
      {(codeFiles.length > 0 || (turnDiff?.files.length ?? 0) > 0) && <FileChangeSummary key={turnDiff?.at} onUndo={onUndo} files={codeFiles} gitDiff={turnDiff} onOpenDiff={onOpenDiff && ((file, turn) => onOpenDiff(file, { ...turn, at: turn.at || messages.at(-1)?.timestamp || 0 }))} onOpenFile={onOpenFile} />}
      {/* 回答结束后，悬浮显示复制与完成时间。 */}
      {!live && <MessageActions text={answerText} time={latest?.timestamp} label="复制回答" />}
    </div>
  </div>;
}

function sameMessageSequence(previous: ChatMessage[], next: ChatMessage[]): boolean {
  return previous.length === next.length && previous.every((message, index) => message === next[index]);
}

function sameRelevantToolResults(previous: Map<string, ChatMessage>, next: Map<string, ChatMessage>, messages: ChatMessage[]): boolean {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'toolCall' && previous.get(block.id) !== next.get(block.id)) return false;
    }
  }
  return true;
}

function sameAssistantTurnViewProps(previous: AssistantTurnViewProps, next: AssistantTurnViewProps): boolean {
  return previous.busy === next.busy
    && previous.id === next.id
    && previous.turnError === next.turnError
    && previous.stepDisplay === next.stepDisplay
    && previous.stepCollapse === next.stepCollapse
    && previous.showCodeView === next.showCodeView
    && previous.cwd === next.cwd
    && previous.onUndo === next.onUndo
    && previous.gitDiff === next.gitDiff
    && previous.onOpenDiff === next.onOpenDiff
    && previous.onOpenFile === next.onOpenFile
    && (previous.requestTraces === next.requestTraces
      || (previous.requestTraces?.length === next.requestTraces?.length
        && (previous.requestTraces || []).every((trace, index) => trace === next.requestTraces?.[index])))
    && (previous.retry === next.retry
      || (previous.retry?.attempt === next.retry?.attempt
        && previous.retry?.maxAttempts === next.retry?.maxAttempts
        && previous.retry?.errorMessage === next.retry?.errorMessage))
    && sameMessageSequence(previous.messages, next.messages)
    && sameRelevantToolResults(previous.toolResults, next.toolResults, previous.messages);
}

/** Completed turns stay mounted but skip work while only the streaming tail changes. */
export const AssistantTurnView = memo(AssistantTurnViewComponent, sameAssistantTurnViewProps);

/**
 * 与输入框共用引用徽章及文件类型图标。
 * 技能块还会把展开后的正文收进可折叠详情，避免一屏都是 SKILL.md。
 */
function MessageReference({ reference }: { reference: Reference }) {
  return <>
    <ReferenceChip reference={reference} />
    {reference.kind === 'skill' && reference.body && <details className="ref-skill-body">
      <summary>技能内容</summary>
      <pre>{reference.body}</pre>
    </details>}
  </>;
}

/** 用户正文：普通文本原样输出，技能/文件引用替换成徽章（不改变消息本身）。 */
function UserText({ text }: { text: string }) {
  const segments = splitMessageText(text);
  return <div className="user-text">
    {segments.map((segment, index) => segment.kind === 'text'
      ? <span key={index}>{segment.text}</span>
      : <MessageReference key={index} reference={segment.reference} />)}
  </div>;
}

/**
 * 单条用户消息气泡。
 *
 * 正文取文本块；附件来自主进程落盘后的 ChatAttachment（展示体积与行数），
 * 图片则从 content 的 image 块内联渲染。
 *
 * @param message 必须是 role === 'user'；assistant / toolResult 由其他视图处理
 * @param id 锚点 id，供右侧大纲跳转
 */
type ChatMessageViewProps = {
  message: ChatMessage;
  id?: string;
  onOpenFile?: (path: string) => void;
  onEdit?: (entryId: number, text: string) => Promise<void>;
  editDisabled?: boolean;
};

function ChatMessageViewComponent({ message, id, onOpenFile, onEdit, editDisabled = false }: ChatMessageViewProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);
  // 兜底：同一组件被误用于其他角色时不渲染，避免出现空气泡。
  if (message.role !== 'user') return null;
  const text = textBlocks(message.content);
  const messageImages = imagesFromBlocks(message.content).map((image) => image.src);
  // 历史里技能命令已被展开成 <skill> 块；复制时还原成用户实际输入的命令形式。
  const copyText = splitMessageText(text)
    .map((segment) => segment.kind === 'text'
      ? segment.text
      : segment.reference.kind === 'skill'
        ? `/skill:${segment.reference.label}`
        : segment.reference.token)
    .join('')
    .trim();
  const preservedCount = messageImages.length + (message.attachments?.length ?? 0);
  const canEdit = Boolean(onEdit && Number.isSafeInteger(message.sourceIndex));

  function resizeEdit() {
    const node = editRef.current;
    if (!node) return;
    node.style.height = '0px';
    node.style.height = `${Math.min(320, Math.max(84, node.scrollHeight))}px`;
  }

  function beginEdit() {
    if (!canEdit || editDisabled) return;
    setDraft(copyText);
    setEditError('');
    setEditing(true);
    requestAnimationFrame(() => {
      resizeEdit();
      const node = editRef.current;
      if (!node) return;
      node.focus();
      node.selectionStart = node.selectionEnd = node.value.length;
    });
  }

  function cancelEdit() {
    if (savingEdit) return;
    setEditing(false);
    setEditError('');
  }

  async function saveEdit() {
    if (!onEdit || !canEdit || savingEdit || editDisabled) return;
    const next = draft.trim();
    if (!next || next === copyText) {
      setEditing(false);
      return;
    }
    setSavingEdit(true);
    setEditError('');
    try {
      await onEdit(message.sourceIndex as number, next);
      setEditing(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingEdit(false);
    }
  }

  return <div id={id} className={`message user ${editing ? 'is-editing' : ''}`}>
  {editing
    ? <div className="message-edit">
      <div className="message-edit-body">
        <textarea
          ref={editRef}
          value={draft}
          aria-label="编辑消息"
          disabled={savingEdit}
          onChange={(event) => {
            setDraft(event.target.value);
            requestAnimationFrame(resizeEdit);
          }}
          onKeyDown={(event) => {
            if (isComposingKey(event.nativeEvent)) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelEdit();
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void saveEdit();
            }
          }}
        />
        {preservedCount > 0 && <div className="message-edit-preserved">保留 {preservedCount} 个图片或附件</div>}
        {editError && <div className="message-edit-error" role="alert">{editError}</div>}
      </div>
      <div className="message-edit-actions">
        <button type="button" className="message-edit-cancel" disabled={savingEdit} onClick={cancelEdit}>取消</button>
        <button type="button" className="message-edit-send" disabled={savingEdit || !draft.trim()} onClick={() => void saveEdit()}>
          {savingEdit ? <LoadingIndicator /> : null}
          {savingEdit ? '发送中' : '发送'}
        </button>
      </div>
    </div>
    : <div className="user-message">
    {/* 附件与图片排在气泡上方：一行、可横向滚动，数量再多也不撑高正文。 */}
    {preservedCount > 0 && <div className="user-attachments">
      <MessageImages blocks={message.content} />
      {message.attachments?.map((attachment) => {
        const openable = Boolean(attachment.path && onOpenFile);
        return <div className={`attachment-card ${openable ? 'is-openable' : ''}`} key={attachment.path} title={`${attachment.path}${openable ? ' · 点击查看' : ''}`}
          role={openable ? 'button' : undefined} tabIndex={openable ? 0 : undefined} aria-label={openable ? `在右侧面板查看 ${attachment.name}` : undefined}
          onClick={() => { if (openable) onOpenFile?.(attachment.path); }}
          onKeyDown={(event) => { if (openable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpenFile?.(attachment.path); } }}>
          <AttachmentIcon name={attachment.name} mime={attachment.mime} />
          <span className="attachment-main"><strong title={attachment.name}>{attachment.name}</strong><span>{formatBytes(attachment.bytes)}{attachment.lines ? ` · ${attachment.lines.toLocaleString('zh-CN')} 行` : ''}</span></span>
          <span className="attachment-kind">{previewTypeLabel(attachment.name)}</span>
          {openable && <span className="attachment-open-cue" aria-hidden="true"><PanelRightOpen /></span>}
        </div>;
      })}
    </div>}
    {text && <div className="user-bubble"><UserText text={text} /></div>}
  </div>}
  {/* 用户消息同样在悬浮时显示复制、编辑与发送时间；复制时带上消息里的图片。 */}
  {!editing && <MessageActions
    text={copyText}
    images={messageImages}
    time={message.timestamp}
    label="复制消息"
    align="end"
    onEdit={canEdit ? beginEdit : undefined}
    editDisabled={editDisabled}
  />}
  </div>;
}

export const ChatMessageView = memo(ChatMessageViewComponent, (previous, next) =>
  previous.message === next.message
  && previous.id === next.id
  && previous.onOpenFile === next.onOpenFile
  && previous.onEdit === next.onEdit
  && previous.editDisabled === next.editDisabled);
