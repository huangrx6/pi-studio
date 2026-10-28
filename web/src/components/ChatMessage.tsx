/**
 * 对话消息渲染：用户消息气泡与助手一轮回复。
 *
 * 两个导出：
 * - ChatMessageView：单条 user 消息（正文、附件卡片、内联图片）；
 * - AssistantTurnView：一轮助手输出。App 会把连续的 assistant 消息合并成一轮，
 *   toolResult 消息通过 toolResults（toolCallId → 消息）配对进对应工具调用。
 *
 * 一轮内部的「轨迹 / 回复」分区：
 * 找到最后一个 thinking / toolCall 块，它之前的块归入「执行轨迹」抽屉，
 * 之后的文本与图片作为最终回复直接展示；没有轨迹时全部视为回复。
 * 这样多步工具调用不会把最终答案顶到屏幕外。
 *
 * 展开状态：默认由偏好 stepDisplay（精简/标准/详细）和 stepCollapse
 * （回答结束后/保持展开/手动）决定；用户手动 toggle 会立即更新本地状态，
 * 但运行状态或偏好再次变化时，自动策略会重新覆盖。
 *
 * IPC：本组件不直接调用 IPC，消息来自 App 的 piApi.session / onPrompt 事件；
 * 图片以 data URI 内联渲染，不再额外请求主进程。
 */
import { useEffect, useState } from 'react';
import { Activity, Brain, ChevronDown, CircleAlert, CircleCheck, CircleX, FileText, LoaderCircle, Pencil, Search, Terminal, Wrench } from 'lucide-react';
import type { ChatMessage, ContentBlock, ToolCallBlock } from '../chat-types';
import type { StepCollapse, StepDisplay } from '../preferences';
import { AttachmentIcon, attachmentVisual } from './AttachmentIcon';
import { Markdown } from './Markdown';

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
  return <div className="message-images">{images.map((block, index) => block.type === 'image' && <img key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="" />)}</div>;
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

/** 工具名对应的色调 class；和 ToolIcon 共用同一套分类，便于轨迹节点与图标配色一致。 */
function toolTone(name: string): string {
  if (name === 'bash' || name === 'powershell') return 'tone-shell';
  if (name === 'read') return 'tone-read';
  if (name === 'grep' || name === 'find' || name === 'ls') return 'tone-search';
  if (name === 'edit' || name === 'write') return 'tone-edit';
  return 'tone-tool';
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
type ActivityEntry = ToolEntry | ThinkingEntry | TextEntry;
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
  return <details className={`activity-tool ${failed ? 'is-error' : ''} ${done ? 'is-done' : 'is-running'}`}>
    <summary>
      <span className="activity-tool-name">{call.name}</span>
      {summary && <span className="activity-tool-summary">{summary}</span>}
      <span className="activity-tool-status">{failed ? <><CircleX />失败</> : done ? <><CircleCheck />完成</> : <><LoaderCircle className={busy ? 'spin' : ''} />运行中</>}</span>
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
  return <details className="activity-thinking">
    <summary>
      <span className="activity-thinking-label">思考过程</span>
      {preview && <span className="activity-thinking-preview">{preview}</span>}
      <ChevronDown className="activity-thinking-chevron" />
    </summary>
    {!block.redacted && block.thinking && <div className="activity-thinking-body"><Markdown>{block.thinking}</Markdown></div>}
  </details>;
}

/**
 * 轨迹左侧时间线节点：思考用大脑图标，工具按类型着色，普通文本用小圆点。
 * 只做视觉标识，不承载交互。
 */
function ActivityNode({ entry }: { entry: ActivityEntry }) {
  if (entry.kind === 'thinking') return <span className="activity-node is-thinking"><Brain /></span>;
  if (entry.kind === 'tool') return <span className={`activity-node is-tool ${toolTone(entry.call.name)}`}><ToolIcon name={entry.call.name} /></span>;
  return <span className="activity-node is-note" />;
}

/** 轨迹摘要顶部的脉冲条颜色：与节点保持同一套分类。 */
function activityColor(entry: ActivityEntry): string {
  if (entry.kind === 'thinking') return 'is-thinking';
  if (entry.kind === 'tool') return toolTone(entry.call.name);
  return 'is-note';
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
 * @param showCodeView 是否展示从工具参数里提取的代码文件清单
 *
 * live 兼看两种“还在进行”信号：正在自动重试，或会话忙且本轮有 streaming
 * 消息。failed 只在非 live 时成立，避免把可恢复的重试中间态显示成最终失败。
 */
export function AssistantTurnView({ messages, toolResults, busy, id, retry, stepDisplay = 'standard', stepCollapse = 'after-answer', showCodeView = false }: { messages: ChatMessage[]; toolResults: Map<string, ChatMessage>; busy: boolean; id?: string; retry?: { attempt: number; maxAttempts: number; errorMessage?: string }; stepDisplay?: StepDisplay; stepCollapse?: StepCollapse; showCodeView?: boolean }) {
  const live = Boolean(retry) || (busy && messages.some((message) => message.streaming));
  const failed = !live && messages.some((message) => message.errorMessage);
  // 初始值只在挂载时取一次；之后由下面的 effect 和用户手动 toggle 接管。
  const [activityOpen, setActivityOpen] = useState(stepDisplay === 'detailed' || live);
  // 自动展开/收起策略：
  // - detailed 始终展开、compact 始终收起（用户仍可手动点开）；
  // - standard 在运行中展开（manual 模式除外），回答结束后按 stepCollapse 决定。
  // 把 live 放进依赖，“开始运行 / 结束运行”就是自动切换的触发点。
  useEffect(() => {
    if (stepDisplay === 'detailed') { setActivityOpen(true); return; }
    if (stepDisplay === 'compact') { setActivityOpen(false); return; }
    if (live) {
      if (stepCollapse !== 'manual') setActivityOpen(true);
    } else if (stepCollapse === 'after-answer') {
      setActivityOpen(false);
    }
  }, [live, stepCollapse, stepDisplay]);
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
    if (entry.block.type === 'thinking') return [{ kind: 'thinking', block: entry.block }];
    if (entry.block.type === 'toolCall') return [{ kind: 'tool', call: entry.block }];
    if (entry.block.type === 'text' && entry.block.text.trim()) return [{ kind: 'text', text: entry.block.text }];
    return [];
  });
  // 顶部指标按整轮原始消息统计，不依赖上面的分区结果，避免统计口径随轨迹过滤变化。
  const toolCount = messages.reduce((total, message) => total + message.content.filter((block) => block.type === 'toolCall').length, 0);
  const thinkingCount = messages.reduce((total, message) => total + message.content.filter((block) => block.type === 'thinking').length, 0);
  const latest = messages[messages.length - 1];
  // 代码工作视图：从工具参数里取 path / file_path 去重，最多展示 6 个文件。
  const codeFiles = [...new Set(messages.flatMap((message) => message.content.flatMap((block) => {
    if (block.type !== 'toolCall') return [];
    const args = block.arguments || {};
    const target = args.path || args.file_path;
    return typeof target === 'string' ? [target] : [];
  })))].slice(0, 6);
  const error = messages.find((message) => message.errorMessage)?.errorMessage;
  return <div id={id} className={`assistant-turn ${live ? 'is-live' : ''} ${retry ? 'is-retrying' : ''} ${failed ? 'has-error' : ''} is-steps-${stepDisplay}`}>
    <div className="assistant-turn-rail"><span className="assistant-orb">π</span></div>
    <div className="assistant-turn-main">
      {/* 头部：状态（重试/失败/处理中/已完成）、步数、工具与思考计数、最后时间。 */}
      <div className="assistant-turn-head">
        <span className="assistant-turn-name">Pi</span>
        <span className="assistant-turn-status" title={retry?.errorMessage}>{retry ? `重试中 ${retry.attempt}/${retry.maxAttempts}` : failed ? '失败' : live ? '正在处理' : '已完成'}</span>
        <span className="assistant-turn-meta">
          {messages.length > 1 && <span><span className="turn-dot" />{messages.length} 步</span>}
          {toolCount > 0 && <span className="turn-metric-tools"><Wrench />{toolCount}</span>}
          {thinkingCount > 0 && <span className="turn-metric-thinking"><Brain />{thinkingCount}</span>}
        </span>
        {latest?.timestamp && <time>{formatTime(latest.timestamp)}</time>}
      </div>
      {/* 执行轨迹抽屉：open 受状态控制，onToggle 把用户手动操作写回本地状态；
          收起时不渲染日志内容，避免大量 Markdown 解析开销。 */}
      {activity.length > 0 && <details className="activity-drawer" open={activityOpen} onToggle={(event) => setActivityOpen(event.currentTarget.open)}>
        <summary>
          <span className="activity-symbol"><Activity /></span>
          <span className="activity-title">执行轨迹</span>
          <span className="activity-pulse" aria-hidden="true">{activity.slice(0, 24).map((entry, index) => <i key={index} className={activityColor(entry)} />)}</span>
          <span className="activity-summary">{toolCount} 工具 · {thinkingCount} 思考</span>
          <ChevronDown className="activity-chevron" />
        </summary>
        {activityOpen && <div className="activity-log">
          {/* 逐条淡入：延迟按 24ms 递增并封顶 14 条，长轨迹不必等太久。 */}
          {activity.map((entry, index) => <div className={`activity-line is-${entry.kind}`} key={`${entry.kind}-${index}`} style={{ animationDelay: `${Math.min(index, 14) * 24}ms` }}>
            <div className="activity-gutter"><ActivityNode entry={entry} /></div>
            <div className="activity-content">
              {entry.kind === 'tool' && <ActivityTool call={entry.call} result={toolResults.get(entry.call.id)} busy={busy} />}
              {entry.kind === 'thinking' && <ActivityThinking block={entry.block} />}
              {entry.kind === 'text' && <div className="activity-note"><Markdown>{entry.text}</Markdown></div>}
            </div>
          </div>)}
        </div>}
      </details>}
      {/* 代码工作视图：开关来自设置（showCodeView），只展示去重后的前 6 个文件。 */}
      {showCodeView && codeFiles.length > 0 && <div className="code-work-view"><span className="code-work-label">代码工作视图</span>{codeFiles.map((file) => <code key={file}>{file}</code>)}</div>}
      {/* 最终回复区：只渲染文本与图片；live 时在末尾显示流式光标。 */}
      {responseBlocks.length > 0 && <div className="assistant-response">
        {responseBlocks.map((entry) => entry.block.type === 'text' && entry.block.text
          ? <Markdown key={entry.key}>{entry.block.text}</Markdown>
          : entry.block.type === 'image'
            ? <img className="message-image" key={entry.key} src={`data:${entry.block.mimeType};base64,${entry.block.data}`} alt="" />
            : null)}
        {live && <span className="caret" />}
      </div>}
      {/* 失败卡片只在非 live 时出现，避免自动重试过程中闪错误。 */}
      {!live && error && <AssistantError message={error} />}
      {/* live 但还没有任何回复块（刚发起）时，单独显示光标。 */}
      {live && responseBlocks.length === 0 && <span className="caret" />}
    </div>
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
export function ChatMessageView({ message, id }: { message: ChatMessage; id?: string }) {
  // 兜底：同一组件被误用于其他角色时不渲染，避免出现空气泡。
  if (message.role !== 'user') return null;
  const text = textBlocks(message.content);
  return <div id={id} className="message user"><div className="user-bubble">
    {text && <div className="user-text">{text}</div>}
    {/* 附件卡片展示名称、体积/行数与类型角标；title 给出去向的绝对路径。 */}
    {message.attachments?.map((attachment) => {
      const visual = attachmentVisual(attachment.name, attachment.mime);
      return <div className="attachment-card" key={attachment.path} title={attachment.path}>
        <AttachmentIcon name={attachment.name} mime={attachment.mime} />
        <span className="attachment-main"><strong>{attachment.name}</strong><span>{formatBytes(attachment.bytes)}{attachment.lines ? ` · ${attachment.lines.toLocaleString('zh-CN')} 行` : ''}</span></span>
        <span className={`attachment-kind ${visual.tone}`}>{visual.label.toUpperCase()}</span>
      </div>;
    })}
    <MessageImages blocks={message.content} />
  </div></div>;
}
