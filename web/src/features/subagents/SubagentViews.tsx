import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleX,
  Clock3,
  Cpu,
  FolderGit2,
  GitFork,
  Layers3,
  MessageCircleReply,
  MessageSquare,
  RefreshCw,
  X,
  Rows3,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
} from 'lucide-react';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import type { ChatMessage } from '../../types/chat-types';
import type { ModelSelection } from '../../types/model-types';
import type { StepCollapse, StepDisplay } from '../../shared/preferences';
import type { SubagentBudgetSnapshot, SubagentChild, SubagentTranscript } from '../../types/subagent-types';
import { AssistantTurnView, ChatMessageView } from '../conversation/ChatMessage';
import { Select } from '../../shared/Select';
import { SessionViewHeader } from '../../shell/SessionViewHeader';
import { errorText } from '../../shared/error-text';
import { duration, hasEnded, isActive, liveDuration, needsAttention, STATUS_LABEL, statusIcon, tokenCount } from './subagent-display';
import { SubagentFlow } from './SubagentFlow';
import { SubagentAvatar } from './SubagentAvatar';
import { InfoHint } from '../../shared/InfoHint';
import { isComposingKey } from '../../shared/keyboard-navigation';
import { formatShortcut } from '../../shared/shortcuts';

export type SubagentOverviewMode = 'formation' | 'list';

const THINKING_LABEL: Record<string, string> = {
  off: '关闭',
  minimal: '极少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};

function thinkingLabel(value?: string): string {
  return value ? THINKING_LABEL[value] || value : '继承';
}

function contextLabel(context?: SubagentChild['context']): string {
  if (context === 'fork') return '分叉上下文';
  if (context === 'fresh') return '独立上下文';
  return '上下文未标记';
}

function ChildRow({
  child,
  now,
  onOpen,
  onDelete,
  onReply,
  deleting,
  replyingChildKey,
}: {
  child: SubagentChild;
  now: number;
  onOpen: () => void;
  onDelete: () => void;
  onReply: (requestId: string, message: string) => Promise<void>;
  deleting: boolean;
  replyingChildKey?: string;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyError, setReplyError] = useState('');
  const replyButton = useRef<HTMLButtonElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);
  const requests = child.supervisorRequests ?? [];
  const request = requests.find(entry => entry.id === selectedRequest) ?? requests[0];
  const replyText = request ? drafts[request.id] ?? '' : '';
  const replyBusy = Boolean(replyingChildKey);
  const replying = replyingChildKey === child.key;
  const name = child.name || child.agent;
  const elapsed = liveDuration(child, now);
  const failure = child.status === 'failed' ? child.error : undefined;
  const tool = isActive(child.status) ? child.currentTool : undefined;
  const note = failure || request?.question || tool || child.preview;
  const noteLabel = failure ? '失败原因' : request ? '待确认' : tool ? '当前工具' : '最近输出';

  async function sendReply() {
    const message = replyText.trim();
    if (!request || !message || replyBusy) return;
    setReplyError('');
    try {
      await onReply(request.id, message);
      setDrafts(current => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setReplyOpen(false);
      (replyButton.current ?? recordButton.current)?.focus();
    } catch (cause) {
      setReplyError(errorText(cause));
    }
  }

  return <article className={`agent-list-row is-${child.status}`}>
    <div className="agent-list-main">
      <SubagentAvatar id={child.avatarId} />
      <div className="agent-list-copy">
        <div className="agent-list-title"><strong>{name}</strong><span>{STATUS_LABEL[child.status]}</span></div>
        <p className="agent-list-task">{child.task || '未记录任务说明'}</p>
        {note && note !== child.task && <p className={`agent-list-note${failure ? ' is-error' : ''}`} title={note}>
          <b>{noteLabel}</b>{note}
        </p>}
        <div className="agent-list-facts">
          <span>{child.model || '继承模型'}</span>
          <span>{child.isolation === 'worktree' ? '隔离工作树' : '共享工作区'}</span>
          {elapsed !== undefined && <span>耗时 {duration(elapsed)}</span>}
          {child.toolCount !== undefined && <span>{child.toolCount} 次工具调用</span>}
          {child.tokens !== undefined && <span>{tokenCount(child.tokens)} Token</span>}
          {child.referenceCostUsd !== undefined && <span>参考成本 ${child.referenceCostUsd.toFixed(3)}</span>}
        </div>
      </div>
    </div>
    <div className="agent-list-actions">
      {request && <button ref={replyButton} type="button" className="agent-list-reply" aria-expanded={replyOpen}
        onClick={() => { setReplyOpen(!replyOpen); setReplyError(''); }}><MessageCircleReply />回复{requests.length > 1 && ` (${requests.length})`}</button>}
      {child.hasTranscript
        ? <button ref={recordButton} type="button" className="agent-record-link" aria-label={`查看 ${name} 的记录`} onClick={onOpen}>查看记录<ChevronRight /></button>
        : <span className="agent-record-unavailable">暂无记录</span>}
      <button type="button" className="agent-list-delete" disabled={deleting} aria-label={`删除子智能体${name}`} title="删除子智能体及其上下文" onClick={onDelete}>
        {deleting ? <LoadingIndicator /> : <Trash2 />}
      </button>
    </div>
    {replyOpen && request && <form className="agent-supervisor-reply" onSubmit={event => { event.preventDefault(); void sendReply(); }}>
      {requests.length > 1 && <Select label="选择待回复的问题" value={request.id} disabled={replyBusy}
        options={requests.map((entry, index) => ({ value: entry.id, label: `${index + 1}. ${entry.question}` }))}
        onChange={id => { setSelectedRequest(id); setReplyError(''); }} />}
      <label><span>{request.question}</span>
        <textarea autoFocus rows={2} maxLength={16_000} value={replyText} disabled={replyBusy} placeholder="回复子智能体…"
          onChange={event => {
            const value = event.target.value;
            setDrafts(current => ({ ...current, [request.id]: value }));
          }}
          onKeyDown={event => {
            if (!isComposingKey(event.nativeEvent) && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void sendReply();
            }
          }} />
      </label>
      {replyError && <p role="alert">{replyError}</p>}
      <div className="agent-reply-actions">
        <button type="button" className="text-button" onClick={() => { setReplyOpen(false); replyButton.current?.focus(); }}>收起</button>
        <button type="submit" className="primary-button" title={`发送回复（${formatShortcut('Mod+Enter')}）`} aria-keyshortcuts="Control+Enter Meta+Enter" disabled={!replyText.trim() || replyBusy}>{replying ? <LoadingIndicator /> : <Send />}发送回复</button>
      </div>
    </form>}
  </article>;
}

/**
 * The parent conversation owns subagent creation. This read-only overview only
 * projects records produced when the parent invokes its subagent tool.
 */
export function SubagentOverview({
  children,
  budget,
  hidden = false,
  selection,
  refreshing,
  error,
  onRefresh,
  onOpenChild,
  onDeleteChild,
  onReplyChild,
  deletingChildKey,
  replyingChildKey,
  onReturnMain,
  mode = 'list',
  onModeChange,
}: {
  children: SubagentChild[];
  budget?: SubagentBudgetSnapshot | null;
  hidden?: boolean;
  selection: ModelSelection;
  refreshing: boolean;
  error?: string | null;
  onRefresh: () => void;
  onOpenChild: (child: SubagentChild) => void;
  onDeleteChild: (child: SubagentChild) => void;
  onReplyChild: (child: SubagentChild, requestId: string, message: string) => Promise<void>;
  deletingChildKey?: string;
  replyingChildKey?: string;
  onReturnMain: () => void;
  mode?: SubagentOverviewMode;
  onModeChange?: (mode: SubagentOverviewMode) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [query, setQuery] = useState('');
  const opener = useRef<HTMLElement | null>(null);
  function openRecord(child: SubagentChild) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onOpenChild(child);
  }
  useEffect(() => {
    if (!hidden && opener.current) {
      opener.current.focus({ preventScroll: true });
      opener.current = null;
    }
  }, [hidden]);
  const [filter, setFilter] = useState<'all' | 'attention' | 'active' | 'ended'>('all');
  const { active, ended, attention, sections, visible } = useMemo(() => {
    const active = children.filter(child => isActive(child.status)).length;
    const ended = children.filter(child => hasEnded(child.status)).length;
    const attention = children.filter(needsAttention).length;
    const queryText = query.trim().toLocaleLowerCase();
    const groups = {
      attention: { id: 'attention', label: '需要处理', children: [] as SubagentChild[] },
      active: { id: 'active', label: '运行中', children: [] as SubagentChild[] },
      ended: { id: 'ended', label: '已结束', children: [] as SubagentChild[] },
    };
    for (const child of children) {
      if (filter === 'attention' && !needsAttention(child)) continue;
      if (filter === 'active' && !isActive(child.status)) continue;
      if (filter === 'ended' && !hasEnded(child.status)) continue;
      if (queryText && ![child.name, child.agent, child.task, child.preview, child.model, child.error, child.currentTool, STATUS_LABEL[child.status],
        ...(child.supervisorRequests ?? []).map(request => request.question)].join(' ').toLocaleLowerCase().includes(queryText)) continue;
      const primaryGroup = needsAttention(child) ? 'attention' : isActive(child.status) ? 'active' : 'ended';
      groups[filter === 'all' ? primaryGroup : filter].children.push(child);
    }
    const sections = Object.values(groups);
    return { active, ended, attention, sections, visible: sections.flatMap(section => section.children) };
  }, [children, filter, query]);
  const ticking = children.some(child => child.durationMs === undefined && child.startedAt !== undefined && (isActive(child.status) || child.status === 'waiting'));
  const totalTokens = budget?.tokens ?? (children.some(child => child.tokens !== undefined)
    ? children.reduce((sum, child) => sum + (child.tokens ?? 0), 0) : undefined);
  const totalCost = budget?.costUsd ?? (children.some(child => child.referenceCostUsd !== undefined)
    ? children.reduce((sum, child) => sum + (child.referenceCostUsd ?? 0), 0) : undefined);
  const background = children.filter(child => child.source === 'background').length;
  const questions = children.reduce((sum, child) => sum + (child.supervisorRequests?.length ?? 0), 0);
  const overviewSummary = [
    children.length > background && `${children.length - background} 个前台任务`,
    background > 0 && `${background} 个后台任务`,
    questions > 0 && `${questions} 个问题待回复`,
  ].filter(Boolean).join(' · ');
  const effectiveMode = mode === 'formation' && children.length > 1 ? 'formation' : 'list';

  useEffect(() => {
    if (hidden || !ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hidden, ticking]);

  return <div className="agent-overview" hidden={hidden}>
    <SessionViewHeader className="agent-overview-head" title="子智能体"
      summary={overviewSummary}>
      <div className="agent-overview-actions">
        {children.length > 1 && <div className="agent-overview-layout" role="group" aria-label="子智能体视图">
          <button
            type="button"
            className={effectiveMode === 'formation' ? 'is-active' : ''}
            aria-label="流程图视图"
            aria-pressed={effectiveMode === 'formation'}
            title="流程图视图"
            onClick={() => onModeChange?.('formation')}
          ><GitFork /></button>
          <button
            type="button"
            className={effectiveMode === 'list' ? 'is-active' : ''}
            aria-label="列表视图"
            aria-pressed={effectiveMode === 'list'}
            title="列表视图"
            onClick={() => onModeChange?.('list')}
          ><Rows3 /></button>
        </div>}
        {active > 0 && <span className="agent-live-indicator" role="status" aria-label="状态实时更新" title="状态实时更新"><i /></span>}
        <button type="button" className="agent-refresh" aria-label="刷新子智能体" title="刷新" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? <LoadingIndicator /> : <RefreshCw />}
        </button>
      </div>
    </SessionViewHeader>
    {error && <div className="agent-context-alert" role="alert"><CircleX /><div><strong>未能刷新任务列表</strong><p>{error}</p></div>
      <button type="button" className="text-button" disabled={refreshing} onClick={onRefresh}>重试</button></div>}

    {children.length > 0 && <>
      <div className="agent-fleet-strip" aria-label="子智能体任务筛选">
        {([
          ['all', '全部任务', children.length], ['attention', '需处理', attention],
          ['active', '运行中', active], ['ended', '已结束', ended],
        ] as const).map(([value, label, count]) => <button key={value} type="button" className={`is-${value}`} aria-pressed={filter === value}
          onClick={() => setFilter(value)}><span>{label}</span><strong>{count}</strong></button>)}
      </div>
      {budget?.exceeded && (
        <div className="agent-budget-alert">
          <CircleX />
          <span>
            子智能体预算已用尽。
            {budget.budgetAction === 'stop'
              ? '新的子智能体请求会被阻止，可在设置中提高预算。'
              : '当前仅提醒，新的子智能体请求仍可运行。'}
          </span>
        </div>
      )}
      <div className="agent-list-tools">
        <div className="agent-list-search">
          <Search />
          <input value={query} placeholder="搜索任务、模型或输出" aria-label="搜索子智能体" onChange={event => setQuery(event.target.value)} />
          {query && <button type="button" title="清空搜索" aria-label="清空子智能体搜索" onClick={() => setQuery('')}><X /></button>}
        </div>
        <div className="agent-usage" aria-label="子智能体用量">
          {totalTokens !== undefined && <span>{tokenCount(totalTokens)}{budget?.budgetTokens ? ` / ${tokenCount(budget.budgetTokens)}` : ''} Token</span>}
          {totalCost !== undefined && <span>参考成本 ${totalCost.toFixed(3)}{budget?.budgetCostUsd ? ` / $${budget.budgetCostUsd.toFixed(2)}` : ''}</span>}
        </div>
      </div>
    </>}

    {visible.length > 0
      ? effectiveMode === 'formation'
        ? <SubagentFlow
          children={visible}
          now={now}
          selection={selection}
          onOpenChild={openRecord}
          onReturnMain={onReturnMain}
        />
        : <section className="agent-list" aria-label="子智能体列表">
          {sections.filter(section => section.children.length > 0).map(section => (
            <div className="agent-list-section" key={section.id}>
              <h3>{section.label}<span>{section.children.length}</span></h3>
              {section.children.map(child => (
                <ChildRow
                  key={child.key}
                  child={child}
                  now={now}
                  onOpen={() => openRecord(child)}
                  onDelete={() => onDeleteChild(child)}
                  onReply={(requestId, message) => onReplyChild(child, requestId, message)}
                  deleting={deletingChildKey === child.key}
                  replyingChildKey={replyingChildKey}
                />
              ))}
            </div>
          ))}
        </section>
      : !children.length && refreshing ? <LoadingState variant="section">正在读取任务列表…</LoadingState>
      : !children.length && error ? null : <div className={`agent-overview-empty${children.length ? ' is-filtered' : ' is-initial'}`} role="status">
        <span className="agent-overview-empty-icon" aria-hidden="true"><GitFork /></span>
        <strong>{children.length ? '没有匹配结果' : '这次对话还没有子智能体'}</strong>
        {children.length ? <button type="button" className="text-button" onClick={() => { setQuery(''); setFilter('all'); }}>清除筛选</button>
          : <p>在对话中请主智能体分派任务，随后可以在这里查看进度和回复提问。</p>}
      </div>}
  </div>;
}

function transcriptTurns(messages: ChatMessage[]) {
  const turns: Array<{ kind: 'user'; message: ChatMessage } | { kind: 'assistant'; messages: ChatMessage[] }> = [];
  for (const message of messages) {
    if (message.role === 'toolResult') continue;
    if (message.role === 'user') {
      turns.push({ kind: 'user', message });
      continue;
    }
    const previous = turns.at(-1);
    if (previous?.kind === 'assistant') previous.messages.push(message);
    else turns.push({ kind: 'assistant', messages: [message] });
  }
  return turns;
}

export function SubagentTranscriptView({
  child,
  transcript,
  loading,
  error,
  stepDisplay,
  stepCollapse,
  showCodeView,
  onRetry,
  onBackMain,
  onOverview,
  onOpenFile,
}: {
  child: SubagentChild;
  transcript: SubagentTranscript | null;
  loading: boolean;
  error: string | null;
  stepDisplay: StepDisplay;
  stepCollapse: StepCollapse;
  showCodeView: boolean;
  onRetry: () => void;
  onBackMain: () => void;
  onOverview: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [taskOpen, setTaskOpen] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  const turns = transcriptTurns(transcript?.messages || []);
  const results = new Map(
    (transcript?.messages || [])
      .filter(message => message.role === 'toolResult' && message.toolCallId)
      .map(message => [message.toolCallId as string, message]),
  );
  const busy = child.status === 'running' || child.status === 'pending';
  const taskText = useRef<HTMLParagraphElement>(null);
  const [longTask, setLongTask] = useState(false);
  useEffect(() => {
    const el = taskText.current;
    if (!el || taskOpen) return;
    const measure = () => setLongTask(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [child.task, taskOpen]);

  return <div className="agent-context-view">
    <div className="agent-context-toolbar">
      <div className="agent-context-toolbar-inner">
        <button ref={back} type="button" className="agent-context-overview" onClick={onOverview}><ArrowLeft />返回列表</button>
        <nav className="agent-context-breadcrumb" aria-label="Agent 上下文路径">
          <span>子智能体</span>
          <ChevronRight />
          <strong>{child.name || child.agent} · {child.index + 1}</strong>
        </nav>
        <button type="button" className="agent-back-main" onClick={onBackMain}><MessageSquare />返回主智能体</button>
      </div>
    </div>

    <div className="agent-context-scroll">
      <div className="agent-context-column">
        {/* One compact row: small mark, name, then the state chips on the right. */}
        <header className="agent-context-head">
          <SubagentAvatar id={child.avatarId} />
          <h2>{child.name || child.agent}</h2>
          <div className="agent-context-state">
            <span className={`agent-status is-${child.status}`}>{statusIcon(child.status)}<span>{STATUS_LABEL[child.status]}</span></span>
            <span className="agent-readonly-status"><ShieldCheck /><span>只读</span></span>
            <InfoHint align="end" label="只读上下文：不会向子智能体发送消息，也不会改变父智能体的工作。" />
          </div>
        </header>
        {child.task && <div className="agent-context-brief">
          <p ref={taskText} className={`agent-context-task${taskOpen ? ' is-open' : ''}`} title={longTask && !taskOpen ? child.task : undefined}>
            {child.task}
          </p>
          {longTask && <button
            type="button"
            className="agent-context-task-toggle"
            aria-expanded={taskOpen}
            onClick={() => setTaskOpen((value) => !value)}
          >
            {taskOpen ? '收起指令' : '展开完整指令'}
            <ChevronDown className={taskOpen ? 'is-open' : undefined} />
          </button>}
        </div>}
        <div className="agent-context-meta">
          <span><Cpu /><small>模型</small><strong>{child.model || '继承父智能体'}</strong></span>
          <span><Sparkles /><small>思考强度</small><strong>{thinkingLabel(child.thinking)}</strong></span>
          <span><FolderGit2 /><small>上下文</small><strong>{contextLabel(child.context)}</strong></span>
          <span><Clock3 /><small>耗时</small><strong>{duration(child.durationMs)}</strong></span>
          <span><Terminal /><small>工具</small><strong>{child.toolCount ?? '—'}</strong></span>
          <span><MessageSquare /><small>Token 数</small><strong>{tokenCount(child.tokens)}</strong></span>
        </div>
        {child.status === 'failed' && child.error && <div className="agent-context-alert" role="status">
          <CircleX />
          <div>
            <strong>这次运行没有完成</strong>
            <p>{child.error}</p>
          </div>
        </div>}
        {loading && !transcript && <LoadingState variant="section">正在读取子智能体会话…</LoadingState>}
        {!child.hasTranscript && <p className="agent-record-unavailable">暂无会话记录</p>}
        {error && <div className="agent-transcript-error" role="alert"><CircleX /><strong>{transcript ? '更新记录失败' : '无法打开这个上下文'}</strong><p>{error}</p>
          <button type="button" className="text-button" disabled={loading} onClick={onRetry}>重新读取</button></div>}
        {transcript?.hasMore && <div className="agent-transcript-window"><Layers3 /><span>只显示最近 {transcript.messages.length} / {transcript.totalMessages} 条消息</span></div>}
        {transcript && turns.length > 0 && <div className="agent-transcript messages">
          {turns.map((turn, index) => turn.kind === 'user'
            ? <ChatMessageView
              key={`user-${turn.message.sourceIndex ?? turn.message.timestamp ?? index}`}
              message={turn.message}
              onOpenFile={onOpenFile}
            />
            : <AssistantTurnView
              key={`assistant-${turn.messages[0]?.sourceIndex ?? turn.messages[0]?.timestamp ?? index}`}
              messages={turn.messages}
              toolResults={results}
              cwd={child.cwd}
              busy={busy && index === turns.length - 1}
              stepDisplay={stepDisplay}
              stepCollapse={stepCollapse}
              showCodeView={showCodeView}
              onOpenFile={onOpenFile}
            />)}
        </div>}
        {!loading && !error && transcript && turns.length === 0 && <div className="agent-overview-empty">
          <MessageSquare />
          <strong>这份会话还没有消息</strong>
        </div>}
      </div>
    </div>
  </div>;
}
