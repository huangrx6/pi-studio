import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleX,
  Clock3,
  Cpu,
  FolderGit2,
  GitFork,
  Layers3,
  LoaderCircle,
  MessageCircleReply,
  MessageSquare,
  Pause,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
} from 'lucide-react';
import type { ChatMessage } from '../../types/chat-types';
import type { ModelSelection } from '../../types/model-types';
import type { StepCollapse, StepDisplay } from '../../shared/preferences';
import type { SubagentBudgetSnapshot, SubagentChild, SubagentTranscript } from '../../types/subagent-types';
import { AssistantTurnView, ChatMessageView } from '../conversation/ChatMessage';
import { InfoHint } from '../../shared/InfoHint';

const STATUS_LABEL: Record<SubagentChild['status'], string> = {
  pending: '等待启动',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  paused: '已暂停',
  waiting: '等待回复',
};

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

function duration(value?: number): string {
  if (!value || value < 0) return '—';
  if (value < 1_000) return `${value}ms`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function liveDuration(child: SubagentChild, now: number): number | undefined {
  if (typeof child.durationMs === 'number') return child.durationMs;
  if (child.startedAt && ['running', 'pending', 'waiting'].includes(child.status)) {
    return Math.max(0, now - child.startedAt);
  }
  return undefined;
}

function tokenCount(value?: number): string {
  if (value === undefined) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function contextLabel(context?: SubagentChild['context']): string {
  if (context === 'fork') return '分叉上下文';
  if (context === 'fresh') return '独立上下文';
  return '上下文未标记';
}

function statusIcon(status: SubagentChild['status']) {
  if (status === 'running' || status === 'pending') return <LoaderCircle className="spin" />;
  if (status === 'waiting') return <MessageSquare />;
  if (status === 'failed' || status === 'stopped') return <CircleX />;
  if (status === 'paused') return <Pause />;
  return <CheckCircle2 />;
}

function needsAttention(status: SubagentChild['status']): boolean {
  return status === 'waiting' || status === 'failed' || status === 'paused';
}

function isActive(status: SubagentChild['status']): boolean {
  return status === 'running' || status === 'pending';
}

function ChildRow({
  child,
  now,
  onOpen,
  onDelete,
  onReply,
  deleting,
  replying,
}: {
  child: SubagentChild;
  now: number;
  onOpen: () => void;
  onDelete: () => void;
  onReply: (requestId: string, message: string) => Promise<void>;
  deleting: boolean;
  replying: boolean;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const request = child.supervisorRequests?.[0];
  const disabled = !child.hasTranscript;

  async function sendReply() {
    const message = replyText.trim();
    if (!request || !message || replying) return;
    await onReply(request.id, message);
    setReplyText('');
    setReplyOpen(false);
  }

  return <article className={`agent-list-row is-${child.status}${disabled ? ' is-unavailable' : ''}`}>
    <button type="button" className="agent-list-main" disabled={disabled} onClick={onOpen}>
      <span className={`agent-list-state is-${child.status}`}>{statusIcon(child.status)}</span>
      <span className="agent-list-copy">
        <span className="agent-list-title">
          <strong>{child.name || child.agent}</strong>
          <span>{child.currentTool || STATUS_LABEL[child.status]}</span>
        </span>
        <span className="agent-list-task">{request?.question || child.task || '没有提供任务说明。'}</span>
        <span className="agent-list-facts">
          <span>{child.model || '继承模型'}</span>
          <span>{child.isolation === 'worktree' ? '隔离工作树' : '共享工作区'}</span>
          <span>{duration(liveDuration(child, now))}</span>
          <span>{tokenCount(child.tokens)} tok</span>
          {child.referenceCostUsd !== undefined && (
            <span>${child.referenceCostUsd.toFixed(child.referenceCostUsd < 1 ? 3 : 2)}</span>
          )}
        </span>
      </span>
    </button>
    <div className="agent-list-actions">
      {request && (
        <button type="button" className="agent-list-reply" disabled={replying} onClick={() => setReplyOpen(value => !value)}>
          <MessageCircleReply />回复
        </button>
      )}
      <button
        type="button"
        className="agent-list-delete"
        disabled={deleting}
        aria-label={`删除子智能体${child.name || child.agent}`}
        title="删除子智能体及其上下文"
        onClick={onDelete}
      >
        {deleting ? <LoaderCircle className="spin" /> : <Trash2 />}
      </button>
    </div>
    {replyOpen && request && (
      <form
        className="agent-supervisor-reply"
        onSubmit={(event) => {
          event.preventDefault();
          void sendReply().catch(() => setReplyOpen(true));
        }}
      >
        <label>
          <span>{request.question}</span>
          <textarea
            autoFocus
            rows={2}
            maxLength={16_000}
            value={replyText}
            placeholder="回复子智能体…"
            onChange={event => setReplyText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void sendReply().catch(() => setReplyOpen(true));
              }
            }}
          />
        </label>
        <button type="submit" className="primary-button" disabled={!replyText.trim() || replying}>
          {replying ? <LoaderCircle className="spin" /> : <Send />}发送
        </button>
      </form>
    )}
  </article>;
}

/**
 * The parent conversation owns subagent creation. This read-only overview only
 * projects records produced when the parent invokes its subagent tool.
 */
export function SubagentOverview({
  children,
  budget,
  selection,
  refreshing,
  onRefresh,
  onOpenChild,
  onDeleteChild,
  onReplyChild,
  deletingChildKey,
  replyingChildKey,
  onReturnMain,
}: {
  children: SubagentChild[];
  budget?: SubagentBudgetSnapshot | null;
  selection: ModelSelection;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenChild: (child: SubagentChild) => void;
  onDeleteChild: (child: SubagentChild) => void;
  onReplyChild: (child: SubagentChild, requestId: string, message: string) => Promise<void>;
  deletingChildKey?: string;
  replyingChildKey?: string;
  onReturnMain: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention' | 'active'>('all');
  const active = children.filter(child => isActive(child.status)).length;
  const complete = children.filter(child => child.status === 'completed').length;
  const failed = children.filter(child => child.status === 'failed').length;
  const attention = children.filter(child => needsAttention(child.status)).length;
  const totalTokens = children.reduce((sum, child) => sum + (child.tokens || 0), 0);
  const totalCost = children.reduce((sum, child) => sum + (child.referenceCostUsd || 0), 0);
  const normalizedQuery = query.toLocaleLowerCase().trim();
  const visible = children.filter((child) => {
    if (filter === 'attention' && !needsAttention(child.status)) return false;
    if (filter === 'active' && !isActive(child.status)) return false;
    return !normalizedQuery || (
      [child.name, child.agent, child.task, child.preview, child.model]
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    );
  });
  const sections = [
    { id: 'attention', label: '需要处理', children: visible.filter(child => needsAttention(child.status)) },
    { id: 'active', label: '运行中', children: visible.filter(child => isActive(child.status)) },
    { id: 'done', label: '已结束', children: visible.filter(child => child.status === 'completed' || child.status === 'stopped') },
  ];

  useEffect(() => {
    if (active === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  return <div className="agent-overview">
    <header className="agent-overview-head">
      <h2>子智能体</h2>
      <div className="agent-overview-actions">
        {active > 0 && <span className="agent-live-indicator" role="status" aria-label="状态实时更新" title="状态实时更新"><i /></span>}
        <button type="button" className="agent-refresh" aria-label="刷新子智能体" title="刷新" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw className={refreshing ? 'spin' : undefined} />
        </button>
      </div>
    </header>

    <div className={`agent-fleet-strip${totalCost > 0 || budget?.budgetCostUsd ? ' has-cost' : ''}`} aria-label="子智能体聚合状态">
      <span className="is-active"><small>运行</small><strong>{active}</strong></span>
      <span><small>完成</small><strong>{complete}</strong></span>
      <span className={failed ? 'is-error' : ''}><small>失败</small><strong>{failed}</strong></span>
      <span className={budget?.exceeded ? 'is-error' : ''}>
        <small>Token</small>
        <strong>{tokenCount(totalTokens)}{budget?.budgetTokens ? ` / ${tokenCount(budget.budgetTokens)}` : ''}</strong>
      </span>
      {(totalCost > 0 || Boolean(budget?.budgetCostUsd)) && <span className={budget?.exceeded ? 'is-error' : ''}>
        <small>参考成本</small>
        <strong>
          ${totalCost.toFixed(totalCost < 1 ? 3 : 2)}
          {budget?.budgetCostUsd ? ` / $${budget.budgetCostUsd.toFixed(2)}` : ''}
        </strong>
      </span>}
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

    <button type="button" className="agent-main-return" onClick={onReturnMain}>
      <ArrowLeft />返回主对话<span>{selection.label || selection.modelRef}</span>
    </button>

    <div className="agent-list-tools">
      <div className="agent-list-search">
        <Search />
        <input value={query} placeholder="搜索子智能体" aria-label="搜索子智能体" onChange={event => setQuery(event.target.value)} />
      </div>
      <div className="agent-list-filters" role="group" aria-label="筛选子智能体">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部 {children.length}</button>
        <button type="button" aria-pressed={filter === 'attention'} onClick={() => setFilter('attention')}>需处理 {attention}</button>
        <button type="button" aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>运行中 {active}</button>
      </div>
    </div>

    {visible.length > 0
      ? <section className="agent-list" aria-label="子智能体列表">
        {sections.filter(section => section.children.length > 0).map(section => (
          <div className="agent-list-section" key={section.id}>
            <h3>{section.label}</h3>
            {section.children.map(child => (
              <ChildRow
                key={child.key}
                child={child}
                now={now}
                onOpen={() => onOpenChild(child)}
                onDelete={() => onDeleteChild(child)}
                onReply={(requestId, message) => onReplyChild(child, requestId, message)}
                deleting={deletingChildKey === child.key}
                replying={replyingChildKey === child.key}
              />
            ))}
          </div>
        ))}
      </section>
      : <div className="agent-overview-empty">
        <GitFork />
        <strong>{children.length ? '没有匹配结果' : '这次对话还没有子智能体'}</strong>
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
  onBackMain: () => void;
  onOverview: () => void;
  onOpenFile: (path: string) => void;
}) {
  const turns = transcriptTurns(transcript?.messages || []);
  const results = new Map(
    (transcript?.messages || [])
      .filter(message => message.role === 'toolResult' && message.toolCallId)
      .map(message => [message.toolCallId as string, message]),
  );
  const busy = child.status === 'running' || child.status === 'pending';

  return <div className="agent-context-view">
    <div className="agent-context-toolbar">
      <div className="agent-context-toolbar-inner">
        <button type="button" className="agent-context-overview" onClick={onOverview}><ArrowLeft />返回列表</button>
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
        <header className="agent-context-head">
          <span className="agent-context-avatar"><Bot /></span>
          <div>
            <h2>{child.name || child.agent}</h2>
            {child.task && <p>{child.task}</p>}
          </div>
          <div className="agent-context-state">
            <span className={`agent-status is-${child.status}`}>{statusIcon(child.status)}<span>{STATUS_LABEL[child.status]}</span></span>
            <span className="agent-readonly-status"><ShieldCheck /><span>只读</span></span>
            <InfoHint align="end" label="只读上下文：不会向子智能体发送消息，也不会改变父智能体的工作。" />
          </div>
        </header>
        <div className="agent-context-meta">
          <span><Cpu /><small>模型</small><strong>{child.model || '继承父智能体'}</strong></span>
          <span><Sparkles /><small>思考强度</small><strong>{thinkingLabel(child.thinking)}</strong></span>
          <span><FolderGit2 /><small>上下文</small><strong>{contextLabel(child.context)}</strong></span>
          <span><Clock3 /><small>耗时</small><strong>{duration(child.durationMs)}</strong></span>
          <span><Terminal /><small>工具</small><strong>{child.toolCount ?? '—'}</strong></span>
          <span><MessageSquare /><small>Token 数</small><strong>{tokenCount(child.tokens)}</strong></span>
        </div>
        {loading && <div className="agent-transcript-loading" role="status"><LoaderCircle className="spin" /><span>正在读取子智能体会话…</span></div>}
        {error && <div className="agent-transcript-error"><CircleX /><strong>无法打开这个上下文</strong><p>{error}</p></div>}
        {!loading && !error && transcript?.hasMore && <div className="agent-transcript-window"><Layers3 /><span>只显示最近 {transcript.messages.length} / {transcript.totalMessages} 条消息</span></div>}
        {!loading && !error && transcript && turns.length > 0 && <div className="agent-transcript messages">
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
