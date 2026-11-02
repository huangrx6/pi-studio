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
import { Check, ChevronDown, CircleAlert, CircleCheck, CircleX, Copy, FileText, Image as ImageIcon, LoaderCircle, PanelRightOpen, Pencil, Search, Sparkles, Terminal, Wrench } from 'lucide-react';
import type { ChatMessage, ContentBlock, RequestTrace, ToolCallBlock, TurnDiff, TurnDiffFile } from '../types/chat-types';
import type { StepCollapse, StepDisplay } from '../lib/preferences';
import { AttachmentIcon, attachmentVisual } from './AttachmentIcon';
import { ConversationImageGallery, type ConversationImage } from './ConversationImageGallery';
import { ActivityRequest } from './ModelRequestTrace';
import { Markdown } from './Markdown';
import { collectFileChanges } from '../lib/file-changes';
import { FileChangeSummary } from './FileChangeSummary';
import { splitMessageText, type Reference } from '../lib/references';
import '../styles/execution-trace.css';

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

/** 执行轨迹里的一条工具调用。 */
type ToolEntry = { kind: 'tool'; call: ToolCallBlock };
/** 执行轨迹里的一条思考。 */
type ThinkingEntry = { kind: 'thinking'; block: Extract<ContentBlock, { type: 'thinking' }> };
/** 轨迹条目：工具调用或思考。live 表示仍在执行（工具尚无结果，或思考仍在输出）。 */
type ActivityEntry = (ToolEntry | ThinkingEntry) & { key: string; live?: boolean };
/** 拍平后的内容块；key 由「消息序号-块序号」组成，流式追加时保持稳定。 */
type FlatBlock = { block: ContentBlock; key: string; messageTimestamp?: number };

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
function ActivityTool({ call, result, busy, defaultOpen = false }: { call: ToolCallBlock; result?: ChatMessage; busy: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const failed = Boolean(result?.isError);
  const done = Boolean(result);
  const summary = toolSummary(call);
  const resultText = result ? textBlocks(result.content) : '';
  const resultImages = result ? imagesFromBlocks(result.content) : [];
  return <>
  <details
    className={`activity-tool activity-disclosure ${failed ? 'is-error' : ''} ${done ? 'is-done' : busy ? 'is-running' : 'is-incomplete'}`}
    open={open}
    onToggle={(event) => setOpen(event.currentTarget.open)}
  >
    <summary className="activity-disclosure-summary">
      <span className="activity-tool-icon activity-disclosure-icon"><ToolIcon name={call.name} /></span>
      <span className="activity-tool-name activity-disclosure-title">{call.name}</span>
      {summary && <span className="activity-tool-summary activity-disclosure-preview">{summary}</span>}
      <span className="activity-tool-status">{failed ? <><CircleX />失败</> : done ? <><CircleCheck />完成</> : busy ? <><LoaderCircle className="spin" />执行中</> : <><CircleAlert />未完成</>}</span>
      <ChevronDown className="activity-tool-chevron activity-disclosure-chevron" />
    </summary>
    <div className="activity-tool-body activity-disclosure-body">
      <div className="activity-tool-label">参数</div>
      <pre className="activity-tool-code">{JSON.stringify(call.arguments, null, 2)}</pre>
      {result && <>
        <div className="activity-tool-label">结果</div>
        {resultText && <pre className={`activity-tool-code ${failed ? 'is-error' : ''}`}>{resultText}</pre>}
      </>}
    </div>
  </details>
  {resultImages.length > 0 && <ToolResultImages callId={call.id} images={resultImages} />}
  </>;
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
      {preview && <span className="activity-thinking-preview activity-disclosure-preview">{preview}</span>}
      <ChevronDown className="activity-thinking-chevron activity-disclosure-chevron" />
    </summary>
    {!block.redacted && block.thinking && <div className="activity-thinking-body activity-disclosure-body"><Markdown>{block.thinking}</Markdown></div>}
  </details>;
}

/**
 * 正在推理的思考行。与「决策」行共用同一套行结构（图标 | 标题 | 预览 | 状态 | 箭头），
 * 状态位换成转圈；正文随流式增量更新，超出上限后跟随最新内容。推理结束后变成可折叠的「决策」行。
 */
function LiveThinking({ block }: { block: Extract<ContentBlock, { type: 'thinking' }> }) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [block.thinking]);
  return <div className="activity-thinking is-live activity-disclosure" aria-busy="true">
    <div className="activity-disclosure-summary">
      <span className="activity-thinking-icon activity-disclosure-icon" aria-hidden="true"><Sparkles /></span>
      <span className="activity-thinking-label activity-disclosure-title">思考中</span>
      <span className="activity-thinking-preview activity-disclosure-preview">推理中</span>
      <LoaderCircle className="spin activity-thinking-spinner" aria-hidden="true" />
    </div>
    <div ref={body} className="activity-thinking-body activity-disclosure-body">
      {block.redacted ? <p className="activity-thinking-note">模型未提供推理正文。</p> : <Markdown>{block.thinking}</Markdown>}
    </div>
  </div>;
}

/**
 * 请求失败卡片。
 *
 * 额外从错误文本里提取 HTTP 状态码（4xx/5xx），据此给出可操作的中文提示：
 * 401/403 多半是密钥或来源配置问题，5xx 是服务端临时故障，其他 4xx 是请求参数问题。
 * 提取不到状态码时给通用重试建议。错误原文保留在 pre 里，方便排查。
 */
function AssistantError({ message }: { message: string }) {
  const code = message.match(/(?:^|\s)([45]\d{2})(?=\s|:|$)/)?.[1];
  const hint = code === '401' || code === '403'
    ? '认证未通过，请检查此来源的密钥、环境变量和服务地址是否匹配。'
    : code?.startsWith('5')
    ? '模型服务暂时不可用，可以稍后重新发送。'
    : code?.startsWith('4')
      ? '请求没有被模型服务接受，请检查模型、凭据或参数后重试。'
      : '可以重新发送；如果持续出现，请检查网络和模型服务状态。';
  return <div className="assistant-error">
    <div className="assistant-error-head">
      <span className="assistant-error-mark"><CircleAlert /></span>
      <div className="assistant-error-copy">
        <span className="assistant-error-kicker">REQUEST FAILED</span>
        <strong>模型请求没有完成</strong>
      </div>
      {code && <code className="assistant-error-code">{code}</code>}
    </div>
    <pre className="assistant-error-message">{message}</pre>
    <div className="assistant-error-foot">{hint}</div>
  </div>;
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

/** 复制按钮：点击后短暂切换成对勾，避免额外弹提示。 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  async function copy() {
    if (!text.trim()) return;
    if (!(await writeClipboard(text))) return;
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
function MessageActions({ text, time, label, align = 'start', onEdit, editDisabled = false }: {
  text: string;
  time?: number;
  label: string;
  align?: 'start' | 'end';
  onEdit?: () => void;
  editDisabled?: boolean;
}) {
  if (!text.trim() && !time) return null;
  return <div className={`message-actions is-${align}`}>
    {text.trim() && <CopyButton text={text} label={label} />}
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
function ActivitySequence({ entries, results, stepDisplay }: {
  entries: ActivityEntry[];
  results: Map<string, ChatMessage>;
  stepDisplay: StepDisplay;
}) {
  const defaultOpen = stepDisplay === 'detailed';
  return <section className="activity-sequence" aria-label="本轮执行步骤">
    {entries.map(entry => <div className={`activity-sequence-item is-${entry.kind}`} key={entry.key}>
      {entry.kind === 'tool' && <ActivityTool
        call={entry.call}
        result={results.get(entry.call.id)}
        busy={Boolean(entry.live)}
        defaultOpen={defaultOpen}
      />}
      {entry.kind === 'thinking' && (entry.live
        ? <LiveThinking block={entry.block} />
        : <ActivityThinking block={entry.block} defaultOpen={defaultOpen} />)}
    </div>)}
  </section>;
}

/** 折叠策略只在整轮运行边界或配置变化时应用，流式增量不覆盖手动操作。 */
function TurnTrace({ live, active, policy, phase, steps, requests, errors, children }: {
  live: boolean; active: boolean; policy: StepCollapse; phase: string; steps: number; requests: number;
  errors: number; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(policy !== 'after-answer' || live);
  const bodyId = useId();
  const header = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (policy === 'after-answer') setOpen(live);
    else if (policy === 'keep-open') setOpen(true);
  }, [live, policy]);
  const collapseFromBottom = () => {
    // 底部收起后把入口带回视野，避免长轨迹移除后滚动位置落到另一轮。
    header.current?.scrollIntoView({ block: 'nearest' });
    setOpen(false);
    header.current?.focus({ preventScroll: true });
  };
  return <section className={`turn-trace ${open ? 'is-open' : ''}`} aria-label="执行轨迹">
    <button ref={header} type="button" className="turn-trace-toggle"
      aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
      <span className="turn-trace-mark" aria-hidden="true"><ChevronDown className="turn-trace-chevron" /></span>
      <strong>执行轨迹</strong>
      <span className="turn-trace-count">{[steps > 0 && `${steps} 步`, requests > 0 && `${requests} 次请求`].filter(Boolean).join(' · ')}</span>
      {errors > 0 && <span className="turn-trace-errors"><CircleAlert />{errors} 次异常</span>}
      <span className="turn-trace-state">{active ? phase : open ? '收起' : '展开'}</span>
      {active && <LoaderCircle className="spin" />}
    </button>
    <div id={bodyId} hidden={!open} className="turn-trace-body">
      {children}
      {steps + requests > 6 && <button type="button" className="turn-trace-collapse" onClick={collapseFromBottom}>
        <ChevronDown />收起执行轨迹
      </button>}
    </div>
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
  onOpenDiff?: (file: TurnDiffFile | undefined, turn: TurnDiff) => void;
  onOpenFile?: (path: string) => void;
};

function AssistantTurnViewComponent({ messages, toolResults, requestTraces = [], busy, id, turnError, retry, stepDisplay = 'standard', stepCollapse = 'after-answer', showCodeView = false, cwd, gitDiff, onOpenDiff, onOpenFile }: AssistantTurnViewProps) {
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
    messageTimestamp: message.timestamp,
  })));
  // 最后一次操作仅用于确定“复制回答”的范围；视觉分组在下方按正文边界处理。
  let lastActivity = -1;
  flat.forEach((entry, index) => { if (entry.block.type === 'thinking' || entry.block.type === 'toolCall') lastActivity = index; });
  const activityBlocks = lastActivity >= 0 ? flat.slice(0, lastActivity + 1) : [];
  const responseBlocks = lastActivity >= 0 ? flat.slice(lastActivity + 1) : flat;
  // 轨迹条目只有思考和工具调用；可见文本、图片与请求快照各自分段显示。
  const activity: ActivityEntry[] = activityBlocks.flatMap((entry): ActivityEntry[] => {
    if (entry.block.type === 'thinking') return [{ kind: 'thinking', block: entry.block, key: entry.key }];
    if (entry.block.type === 'toolCall') return [{ kind: 'tool', call: entry.block, key: entry.key }];
    return [];
  });
  // 顶部指标按整轮原始消息统计，不依赖上面的分区结果，避免统计口径随轨迹过滤变化。
  const latest = messages[messages.length - 1];
  const lastBlock = flat.filter(entry => entry.block.type !== 'text' || entry.block.text.trim()).at(-1);
  const currentEntries = live ? activity.filter(entry =>
    entry.kind === 'tool' ? !toolResults.has(entry.call.id)
      : entry.key === lastBlock?.key
  ) : [];
  const currentKeys = new Set(currentEntries.map(entry => entry.key));
  // Every visible text/image breaks a process group, preserving chronological order.
  const timeline: Array<{
    key: string;
    entries?: ActivityEntry[];
    visible?: FlatBlock;
    images?: ConversationImage[];
    request?: RequestTrace;
  }> = [];
  const activityByKey = new Map(activity.map(entry => [entry.key, entry]));
  const orderedTraces = [...requestTraces].sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ));
  let traceIndex = 0;
  // The first actual provider request always precedes the first assistant
  // message in a turn, even when a provider reports a coarse timestamp.
  if (orderedTraces[0]) {
    timeline.push({
      key: `request-${orderedTraces[0].id}`,
      request: orderedTraces[0],
    });
    traceIndex = 1;
  }
  const appendTracesThrough = (timestamp: number) => {
    while (traceIndex < orderedTraces.length && orderedTraces[traceIndex].createdAt <= timestamp) {
      const trace = orderedTraces[traceIndex];
      timeline.push({
        key: `request-${trace.id}`,
        request: trace,
      });
      traceIndex += 1;
    }
  };
  for (const entry of flat) {
    if (entry.messageTimestamp !== undefined) appendTracesThrough(entry.messageTimestamp);
    const record = activityByKey.get(entry.key);
    if (entry.block.type === 'image') {
      const image = { src: `data:${entry.block.mimeType};base64,${entry.block.data}` };
      const tail = timeline.at(-1);
      if (tail?.images) tail.images.push(image);
      else timeline.push({ key: entry.key, images: [image] });
    } else if (entry.block.type === 'text' && entry.block.text.trim()) {
      timeline.push({ key: entry.key, visible: entry });
    } else if (record) {
      const row = { ...record, live: currentKeys.has(entry.key) };
      const tail = timeline.at(-1);
      if (tail?.entries) tail.entries.push(row);
      else timeline.push({ key: entry.key, entries: [row] });
    }
  }
  // A request that has started but whose assistant message has not arrived yet
  // belongs at the live tail of the turn.
  appendTracesThrough(Number.POSITIVE_INFINITY);
  const phase = retry ? `正在重试 ${retry.attempt}/${retry.maxAttempts}`
    : currentEntries.some(entry => entry.kind === 'tool') ? '正在执行'
      : lastBlock?.block.type === 'thinking' ? '正在思考'
        : latest?.streaming && lastBlock?.block.type === 'text' ? '正在回复'
          : orderedTraces.length > 0 && currentEntries.length === 0 ? '正在请求模型'
            : '正在继续处理';

  const codeFiles = showCodeView && !live ? collectFileChanges(messages, toolResults, cwd) : [];
  const turnDiff = showCodeView && !live ? gitDiff : undefined;
  // 复制只包含最终回复的文本块，不包含思考与工具调用。
  const answerText = responseBlocks
    .filter((entry) => entry.block.type === 'text')
    .map((entry) => entry.block.type === 'text' ? entry.block.text : '')
    .join('\n\n')
    .trim();
  // A visible explanation or a new request ends the previous execution segment.
  // Keys use the first item, so streaming appends never reset a manual disclosure.
  const segments: Array<{ key: string; process: boolean; items: typeof timeline }> = [];
  for (const item of timeline) {
    const process = Boolean(item.entries || item.request);
    const tail = segments.at(-1);
    if (process && tail?.process && !item.request) tail.items.push(item);
    else segments.push({ key: item.key, process, items: [item] });
  }
  const renderTimelineItem = (item: typeof timeline[number]) => item.entries
        ? <ActivitySequence key={item.key} entries={item.entries} results={toolResults} stepDisplay={stepDisplay} />
        : item.request ? <ActivityRequest
            key={item.key}
            trace={item.request}
            stepDisplay={stepDisplay}
          />
        : item.images ? <ConversationImageGallery key={item.key} images={item.images} />
        : item.visible?.block.type === 'text' ? <div className="assistant-response" key={item.key}><Markdown>{item.visible.block.text}</Markdown></div> : null;
  return <div id={id} className={`assistant-turn ${live ? 'is-live' : ''} ${retry ? 'is-retrying' : ''} ${failed ? 'has-error' : ''} is-steps-${stepDisplay}`}>
    <div className="assistant-turn-rail"><span className="assistant-orb">π</span></div>
    <div className="assistant-turn-main">
      {/* 头部状态只在整轮结束后变为已完成，工具之间的等待仍是运行中。 */}
      <div className="assistant-turn-head">
        <span className="assistant-turn-name">Pi</span>
        <span className="assistant-turn-status" title={retry?.errorMessage}>{retry ? `重试中 ${retry.attempt}/${retry.maxAttempts}` : interrupted ? '已中断' : failed ? '失败' : live ? phase : '已完成'}</span>
        {latest?.timestamp && <time>{formatTime(latest.timestamp)}</time>}
      </div>
      {segments.map((segment, index) => {
        if (!segment.process) return segment.items.map(renderTimelineItem);
        const entries = segment.items.flatMap(item => item.entries || []);
        return <TurnTrace key={segment.key} live={live} active={live && index === segments.length - 1} policy={stepCollapse} phase={phase}
          steps={entries.length} requests={segment.items.filter(item => item.request).length}
          errors={entries.filter(entry => entry.kind === 'tool' && toolResults.get(entry.call.id)?.isError).length}>
          {segment.items.map(renderTimelineItem)}
        </TurnTrace>;
      })}
      {live && <div className="run-live-status" role="status">
        <span className="run-live-icon activity-disclosure-icon"><LoaderCircle className="spin" /></span>
        <span>{phase}</span>
        <span>本轮尚未结束</span>
      </div>}
      {/* 失败卡片只在非 live 时出现，避免自动重试过程中闪错误。 */}
      {!live && error && (interrupted
        ? <div className="assistant-interrupted" role="status">本轮已中断</div>
        : <AssistantError message={error} />)}
      {(codeFiles.length > 0 || (turnDiff?.files.length ?? 0) > 0) && <FileChangeSummary files={codeFiles} gitDiff={turnDiff} onOpenDiff={(file, turn) => onOpenDiff?.(file, { ...turn, at: turn.at || messages.at(-1)?.timestamp || 0 })} onOpenFile={onOpenFile} />}
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
 * 一枚引用徽章：技能显示上下文菜单图标，文件显示文档图标。
 * 技能块还会把展开后的正文收进可折叠详情，避免一屏都是 SKILL.md。
 */
function ReferenceChip({ reference }: { reference: Reference }) {
  if (reference.kind === 'skill') {
    return <>
      <span className="ref-chip is-skill" title={reference.location || '技能'}>
        <Sparkles aria-hidden="true" />
        {reference.label}
      </span>
      {reference.body && <details className="ref-skill-body">
        <summary>技能内容</summary>
        <pre>{reference.body}</pre>
      </details>}
    </>;
  }
  return <span className="ref-chip is-file" title={reference.location}>
    <FileText aria-hidden="true" />
    {reference.label}
  </span>;
}

/** 用户正文：普通文本原样输出，技能/文件引用替换成徽章（不改变消息本身）。 */
function UserText({ text }: { text: string }) {
  const segments = splitMessageText(text);
  return <div className="user-text">
    {segments.map((segment, index) => segment.kind === 'text'
      ? <span key={index}>{segment.text}</span>
      : <ReferenceChip key={index} reference={segment.reference} />)}
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
  // 历史里技能命令已被展开成 <skill> 块；复制时还原成用户实际输入的命令形式。
  const copyText = splitMessageText(text)
    .map((segment) => segment.kind === 'text'
      ? segment.text
      : segment.reference.kind === 'skill'
        ? `/skill:${segment.reference.label}`
        : segment.reference.token)
    .join('')
    .trim();
  const imageCount = message.content.filter((block) => block.type === 'image').length;
  const preservedCount = imageCount + (message.attachments?.length ?? 0);
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
          {savingEdit ? <LoaderCircle className="spin" /> : null}
          {savingEdit ? '发送中' : '发送'}
        </button>
      </div>
    </div>
    : <div className="user-bubble">
    <MessageImages blocks={message.content} />
    {text && <UserText text={text} />}
    {/* 附件卡片展示名称、体积/行数与类型角标；title 给出去向的绝对路径。 */}
    {message.attachments?.map((attachment) => {
      const visual = attachmentVisual(attachment.name, attachment.mime);
      const openable = Boolean(attachment.path && onOpenFile);
      return <div className={`attachment-card ${openable ? 'is-openable' : ''}`} key={attachment.path} title={`${attachment.path}${openable ? ' · 点击查看' : ''}`}
        role={openable ? 'button' : undefined} tabIndex={openable ? 0 : undefined} aria-label={openable ? `在右侧面板查看 ${attachment.name}` : undefined}
        onClick={() => { if (openable) onOpenFile?.(attachment.path); }}
        onKeyDown={(event) => { if (openable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpenFile?.(attachment.path); } }}>
        <AttachmentIcon name={attachment.name} mime={attachment.mime} />
        <span className="attachment-main"><strong>{attachment.name}</strong><span>{formatBytes(attachment.bytes)}{attachment.lines ? ` · ${attachment.lines.toLocaleString('zh-CN')} 行` : ''}</span></span>
        <span className={`attachment-kind ${visual.tone}`}>{visual.label.toUpperCase()}</span>
        {openable && <span className="attachment-open-cue" aria-hidden="true"><PanelRightOpen /></span>}
      </div>;
    })}
  </div>}
  {/* 用户消息同样在悬浮时显示复制、编辑与发送时间。 */}
  {!editing && <MessageActions
    text={copyText}
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
