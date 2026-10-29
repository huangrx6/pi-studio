/**
 * 对话消息渲染：用户消息气泡与助手一轮回复。
 *
 * 两个导出：
 * - ChatMessageView：单条 user 消息（正文、附件卡片、内联图片）；
 * - AssistantTurnView：一轮助手输出。App 会把连续的 assistant 消息合并成一轮，
 *   toolResult 消息通过 toolResults（toolCallId → 消息）配对进对应工具调用。
 *
 * 一轮内部的「轨迹 / 回复」分区：
 * 正文和图片始终显示；相邻的工具与推理组成独立记录组，保持时间顺序。
 * 当前输出独立展开，已完成的过程可按偏好折叠。
 *
 * 展开状态：默认由偏好 stepDisplay（精简/标准/详细）和 stepCollapse
 * （回答结束后/保持展开/手动）决定；用户手动 toggle 会立即更新本地状态，
 * 但运行状态或偏好再次变化时，自动策略会重新覆盖。
 *
 * IPC：本组件不直接调用 IPC，消息来自 App 的 Durable 会话快照与事件流；
 * 图片以 data URI 内联渲染，不再额外请求主进程。
 */
import { memo, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CircleAlert, CircleCheck, CircleX, Copy, FileText, LoaderCircle, PanelRightOpen, Pencil, Search, Sparkles, Terminal, Wrench } from 'lucide-react';
import type { ChatMessage, ContentBlock, ToolCallBlock, TurnDiff, TurnDiffFile } from '../types/chat-types';
import type { StepCollapse, StepDisplay } from '../lib/preferences';
import { AttachmentIcon, attachmentVisual } from './AttachmentIcon';
import { Markdown } from './Markdown';
import { collectFileChanges } from '../lib/file-changes';
import { FileChangeSummary } from './FileChangeSummary';
import { splitMessageText, type Reference } from '../lib/references';

/** 拼出消息里的全部文本块（用换行分隔）；用户正文和工具结果共用这一逻辑。 */
function textBlocks(blocks: ContentBlock[]): string {
  return blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
}

/**
 * 内联图片列表。
 * 只取 image 块，base64 数据直接拼成 data URI；没有任何图片时不占位。
 *
 * @param blocks 消息内容块（用户消息或工具结果都可能带图片）
 */
function MessageImages({ blocks }: { blocks: ContentBlock[] }) {
  const images = blocks.filter((block) => block.type === 'image');
  if (images.length === 0) return null;
  return <div className="message-images">{images.map((block, index) => block.type === 'image' && <img key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="" loading="lazy" decoding="async" />)}</div>;
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
/** 执行轨迹里夹在工具之间的说明文本（模型的过渡叙述）。 */
type TextEntry = { kind: 'text'; text: string };
/** 轨迹条目联合类型。 */
type ActivityEntry = (ToolEntry | ThinkingEntry | TextEntry) & { key: string };
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
function ActivityTool({ call, result, busy }: { call: ToolCallBlock; result?: ChatMessage; busy: boolean }) {
  const failed = Boolean(result?.isError);
  const done = Boolean(result);
  const summary = toolSummary(call);
  return <details className={`activity-tool ${failed ? 'is-error' : ''} ${done ? 'is-done' : busy ? 'is-running' : 'is-incomplete'}`}>
    <summary>
      <span className="activity-tool-icon"><ToolIcon name={call.name} /></span>
      <span className="activity-tool-name">{call.name}</span>
      {summary && <span className="activity-tool-summary">{summary}</span>}
      <span className="activity-tool-status">{failed ? <><CircleX />失败</> : done ? <><CircleCheck />完成</> : busy ? <><LoaderCircle className="spin" />执行中</> : <><CircleAlert />未完成</>}</span>
      <ChevronDown className="activity-tool-chevron" />
    </summary>
    <div className="activity-tool-body">
      <div className="activity-tool-label">参数</div>
      <pre className="activity-tool-code">{JSON.stringify(call.arguments, null, 2)}</pre>
      {result && <>
        <div className="activity-tool-label">结果</div>
        <pre className={`activity-tool-code ${failed ? 'is-error' : ''}`}>{textBlocks(result.content)}</pre>
        <MessageImages blocks={result.content} />
      </>}
    </div>
  </details>;
}

/**
 * 思考过程折叠块。
 * redacted 时服务端没有返回正文，只显示占位文案；预览压平空白并截断，
 * 展开后才渲染完整 Markdown，避免闭合状态下也做高开销的解析。
 */
function ActivityThinking({ block }: { block: Extract<ContentBlock, { type: 'thinking' }> }) {
  const preview = block.redacted ? '思考内容已隐藏' : block.thinking.replace(/\s+/g, ' ').trim().slice(0, 110);
  return <details className="activity-thinking" aria-label="查看推理内容">
    <summary>
      <Sparkles className="activity-thinking-icon" aria-hidden="true" />
      <span className="activity-thinking-label">Thinking</span>
      {preview && <span className="activity-thinking-preview">{preview}</span>}
      <ChevronDown className="activity-thinking-chevron" />
    </summary>
    {!block.redacted && block.thinking && <div className="activity-thinking-body"><Markdown>{block.thinking}</Markdown></div>}
  </details>;
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

/** 消息下方的悬浮操作行：复制与时间；没有内容时整行隐藏。 */
function MessageActions({ text, time, label, align = 'start' }: { text: string; time?: number; label: string; align?: 'start' | 'end' }) {
  if (!text.trim() && !time) return null;
  return <div className={`message-actions is-${align}`}>
    {text.trim() && <CopyButton text={text} label={label} />}
    {time ? <time className="message-action-time">{formatTime(time)}</time> : null}
  </div>;
}

function ActivityGroup({ entries, results, live, stepDisplay, stepCollapse }: {
  entries: ActivityEntry[]; results: Map<string, ChatMessage>; live: boolean; stepDisplay: StepDisplay; stepCollapse: StepCollapse;
}) {
  const [open, setOpen] = useState(stepDisplay === 'detailed');
  useEffect(() => {
    if (stepDisplay === 'detailed') setOpen(true);
    else if (stepDisplay === 'compact' || !live && stepCollapse === 'after-answer') setOpen(false);
  }, [live, stepDisplay, stepCollapse]);
  if (entries.length === 1 && entries[0].kind === 'thinking') return <div className="standalone-thinking"><ActivityThinking block={entries[0].block} /></div>;
  const count = entries.filter(entry => entry.kind === 'tool').length;
  return <details className="run-history" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><ChevronDown /><span className="run-history-title">{count ? `${count} 项工具操作` : '推理记录'}</span></summary>
    {open && <div className="run-history-list">{entries.map(entry => <div className={`run-history-row is-${entry.kind}`} key={entry.key}>
      {entry.kind === 'tool' && <ActivityTool call={entry.call} result={results.get(entry.call.id)} busy={false} />}
      {entry.kind === 'thinking' && <ActivityThinking block={entry.block} />}
    </div>)}</div>}
  </details>;
}

type AssistantTurnViewProps = {
  messages: ChatMessage[];
  toolResults: Map<string, ChatMessage>;
  busy: boolean;
  id?: string;
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

function AssistantTurnViewComponent({ messages, toolResults, busy, id, retry, stepDisplay = 'standard', stepCollapse = 'after-answer', showCodeView = false, cwd, gitDiff, onOpenDiff, onOpenFile }: AssistantTurnViewProps) {
  const live = Boolean(retry) || busy;
  // 只看本轮最后一条助手消息：压缩/重试产生的中间失败不应盖住后面的成功输出。
  const lastMessage = messages[messages.length - 1];
  const error = !live ? lastMessage?.errorMessage : undefined;
  const interrupted = Boolean(error && /aborted/i.test(error));
  const failed = Boolean(error) && !interrupted;
  // 把本轮所有消息的内容块拍平；key 用「消息序号-块序号」，流式追加时不会错位。
  const flat: FlatBlock[] = messages.flatMap((message, messageIndex) => message.content.map((block, blockIndex) => ({ block, key: `${messageIndex}-${blockIndex}` })));
  // 找到最后一个思考/工具调用块的位置，用它把内容切成「轨迹」与「最终回复」两段。
  // 之所以按最后一个而不是第一个切分：模型可能先回答一段、中途又调用工具，
  // 最后的总结文本必须留在回复区，前面的工具过程才折叠。
  let lastActivity = -1;
  flat.forEach((entry, index) => { if (entry.block.type === 'thinking' || entry.block.type === 'toolCall') lastActivity = index; });
  const activityBlocks = lastActivity >= 0 ? flat.slice(0, lastActivity + 1) : [];
  const responseBlocks = lastActivity >= 0 ? flat.slice(lastActivity + 1) : flat;
  // 轨迹条目只保留思考、工具调用和非空文本；空文本块（流式占位）直接丢弃。
  const activity: ActivityEntry[] = activityBlocks.flatMap((entry): ActivityEntry[] => {
    if (entry.block.type === 'thinking') return [{ kind: 'thinking', block: entry.block, key: entry.key }];
    if (entry.block.type === 'toolCall') return [{ kind: 'tool', call: entry.block, key: entry.key }];
    if (entry.block.type === 'text' && entry.block.text.trim()) return [{ kind: 'text', text: entry.block.text, key: entry.key }];
    return [];
  });
  // 顶部指标按整轮原始消息统计，不依赖上面的分区结果，避免统计口径随轨迹过滤变化。
  const latest = messages[messages.length - 1];
  const lastBlock = flat.filter(entry => entry.block.type !== 'text' || entry.block.text.trim()).at(-1);
  const currentEntries = live ? activity.filter(entry =>
    entry.kind === 'tool' ? !toolResults.has(entry.call.id)
      : entry.kind === 'thinking' ? entry.key === lastBlock?.key
        : false
  ) : [];
  const currentKeys = new Set(currentEntries.map(entry => entry.key));
  // Every visible text/image breaks a process group, preserving chronological order.
  const timeline: Array<{ key: string; entries?: ActivityEntry[]; visible?: FlatBlock; current?: ActivityEntry }> = [];
  const activityByKey = new Map(activity.map(entry => [entry.key, entry]));
  for (const entry of flat) {
    const record = activityByKey.get(entry.key);
    if (entry.block.type === 'text' && entry.block.text.trim() || entry.block.type === 'image') {
      timeline.push({ key: entry.key, visible: entry });
    } else if (record && record.kind !== 'text') {
      if (currentKeys.has(entry.key)) timeline.push({ key: entry.key, current: record });
      else {
        const tail = timeline.at(-1);
        if (tail?.entries) tail.entries.push(record);
        else timeline.push({ key: entry.key, entries: [record] });
      }
    }
  }
  const phase = retry ? `正在重试 ${retry.attempt}/${retry.maxAttempts}`
    : currentEntries.some(entry => entry.kind === 'tool') ? '正在执行'
      : lastBlock?.block.type === 'thinking' ? '正在思考'
        : latest?.streaming && lastBlock?.block.type === 'text' ? '正在回复' : '正在继续处理';

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
      {timeline.map(item => item.entries
        ? <ActivityGroup key={item.key} entries={item.entries} results={toolResults} live={live} stepDisplay={stepDisplay} stepCollapse={stepCollapse} />
        : item.current ? <section className="run-current run-current-inline" key={item.key} aria-label="当前输出" aria-busy="true">
          {item.current.kind === 'thinking' && <><div className="run-current-heading"><Sparkles /><span>推理中</span><LoaderCircle className="spin" /></div>
            {item.current.block.redacted ? <p className="run-current-redacted">模型未提供推理正文。</p> : <Markdown>{item.current.block.thinking}</Markdown>}</>}
          {item.current.kind === 'tool' && <ActivityTool call={item.current.call} result={toolResults.get(item.current.call.id)} busy />}
        </section>
        : item.visible?.block.type === 'text' ? <div className="assistant-response" key={item.key}><Markdown>{item.visible.block.text}</Markdown></div>
        : item.visible?.block.type === 'image' ? <img className="message-image" key={item.key} src={`data:${item.visible.block.mimeType};base64,${item.visible.block.data}`} alt="" loading="lazy" decoding="async" /> : null)}
      {live && <div className="run-live-status" role="status"><LoaderCircle className="spin" /><span>{phase}</span><span>本轮尚未结束</span></div>}
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
    && previous.stepDisplay === next.stepDisplay
    && previous.stepCollapse === next.stepCollapse
    && previous.showCodeView === next.showCodeView
    && previous.cwd === next.cwd
    && previous.gitDiff === next.gitDiff
    && previous.onOpenDiff === next.onOpenDiff
    && previous.onOpenFile === next.onOpenFile
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
type ChatMessageViewProps = { message: ChatMessage; id?: string; onOpenFile?: (path: string) => void };

function ChatMessageViewComponent({ message, id, onOpenFile }: ChatMessageViewProps) {
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
  return <div id={id} className="message user"><div className="user-bubble">
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
    <MessageImages blocks={message.content} />
  </div>
  {/* 用户消息同样在悬浮时显示复制与发送时间。 */}
  <MessageActions text={copyText} time={message.timestamp} label="复制消息" align="end" />
  </div>;
}

export const ChatMessageView = memo(ChatMessageViewComponent, (previous, next) =>
  previous.message === next.message
  && previous.id === next.id
  && previous.onOpenFile === next.onOpenFile);
