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
  MessageSquare,
  Pause,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  UserRound,
  RefreshCw,
} from 'lucide-react';
import type { ChatMessage } from '../types/chat-types';
import type { ModelSelection } from '../types/model-types';
import type { StepCollapse, StepDisplay } from '../lib/preferences';
import type { SubagentChild, SubagentTranscript } from '../types/subagent-types';
import { AssistantTurnView, ChatMessageView } from './ChatMessage';

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
  if (
    child.startedAt
    && ['running', 'pending', 'waiting'].includes(child.status)
  ) {
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
  if (status === 'failed') return <CircleX />;
  if (status === 'paused') return <Pause />;
  if (status === 'stopped') return <CircleX />;
  return <CheckCircle2 />;
}

function AgentMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return <span className="agent-card-metric">{icon}<span>{label}</span><strong>{value}</strong></span>;
}

function ChildCard({
  child,
  number,
  now,
  onOpen,
  onDelete,
  deleting,
}: {
  child: SubagentChild;
  number: number;
  now: number;
  onOpen: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const disabled = !child.hasTranscript;
  return <article className={`agent-child-card is-${child.status} ${disabled ? 'is-unavailable' : ''}`}>
    <button
      type="button"
      className="agent-card-open"
      disabled={disabled}
      title={disabled ? '这个子智能体没有可安全读取的本地会话' : `打开 ${child.agent} 的只读上下文`}
      onClick={onOpen}
    >
      <span className="agent-card-index">{String(number).padStart(2, '0')}</span>
      <div className="agent-card-head">
        <span className="agent-card-avatar"><Bot /></span>
        <div className="agent-card-identity">
          <strong>{child.name || child.agent}</strong>
          <span className="agent-card-source">
            {child.source === 'background' ? '后台' : '前台'} · {contextLabel(child.context)}
            {child.supervisorPending ? ` · ${child.supervisorPending} 个监督请求` : ''}
          </span>
        </div>
        <span className={`agent-status is-${child.status}`}>{statusIcon(child.status)}<span>{STATUS_LABEL[child.status]}</span></span>
      </div>
      <p className="agent-card-task">{child.task || '没有提供任务说明。'}</p>
      {child.currentTool && <div className="agent-card-current"><Terminal /><span>{child.currentTool}</span></div>}
      {child.error && <div className="agent-card-error">{child.error}</div>}
      {!child.currentTool && child.preview && <p className="agent-card-preview">{child.preview}</p>}
      <div className="agent-card-metrics">
        <AgentMetric icon={<Cpu />} label="模型" value={child.model || '继承'} />
        <AgentMetric icon={<Sparkles />} label="思考" value={thinkingLabel(child.thinking)} />
        <AgentMetric icon={<Clock3 />} label="耗时" value={duration(liveDuration(child, now))} />
        <AgentMetric icon={<Layers3 />} label="Token 数" value={tokenCount(child.tokens)} />
        <AgentMetric icon={<Terminal />} label="工具" value={child.toolCount ?? '—'} />
        <AgentMetric icon={<MessageSquare />} label="轮次" value={child.turnCount ?? '—'} />
      </div>
    </button>
    <footer className="agent-card-action">
      <span>{disabled ? '没有可读会话' : '查看上下文'}{!disabled && <ChevronRight />}</span>
      <button
        type="button"
        className="agent-card-delete"
        disabled={deleting}
        title="永久删除这个子智能体及其上下文"
        aria-label={`删除子智能体${child.name || child.agent}`}
        onClick={onDelete}
      >
        {deleting ? <LoaderCircle className="spin" /> : <Trash2 />}
        {deleting ? '删除中' : '删除'}
      </button>
    </footer>
  </article>;
}

export function SubagentOverview({
  children,
  selection,
  refreshing,
  onRefresh,
  onOpenChild,
  onDeleteChild,
  deletingChildKey,
  onReturnMain,
}: {
  children: SubagentChild[];
  selection: ModelSelection;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenChild: (child: SubagentChild) => void;
  onDeleteChild: (child: SubagentChild) => void;
  deletingChildKey?: string;
  onReturnMain: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const active = children.filter((child) => (
    child.status === 'running' || child.status === 'pending' || child.status === 'waiting'
  )).length;
  const complete = children.filter((child) => child.status === 'completed').length;
  const failed = children.filter((child) => child.status === 'failed').length;
  const totalTokens = children.reduce((sum, child) => sum + (child.tokens || 0), 0);
  const totalTools = children.reduce((sum, child) => sum + (child.toolCount || 0), 0);
  const totalDuration = children.reduce((sum, child) => sum + (liveDuration(child, now) || 0), 0);

  useEffect(() => {
    if (active === 0 && !children.some((child) => ['running', 'pending', 'waiting'].includes(child.status))) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, children]);

  return <div className="agent-overview">
    <header className="agent-overview-head">
      <div>
        <span className="agent-overview-eyebrow">多智能体协作</span>
        <h2>子智能体总览</h2>
        <p>同一父会话里的子智能体会集中显示。打开会话会替换当前内容区，顶部“对话”标签和“返回主智能体”都能回到原位置。</p>
      </div>
      <div className="agent-overview-actions">
        {active > 0 && <span className="agent-live-indicator"><i />实时更新</span>}
        <button type="button" className="agent-refresh" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw className={refreshing ? 'spin' : undefined} />
          刷新
        </button>
      </div>
    </header>

    <div className="agent-fleet-strip" aria-label="子智能体聚合状态">
      <span className="is-active"><small>运行中</small><strong>{active}</strong></span>
      <span><small>已完成</small><strong>{complete}</strong></span>
      <span className={failed ? 'is-error' : ''}><small>失败</small><strong>{failed}</strong></span>
      <span><small>累计 Token</small><strong>{tokenCount(totalTokens)}</strong></span>
      <span><small>工具调用</small><strong>{totalTools}</strong></span>
      <span><small>累计耗时</small><strong>{duration(totalDuration)}</strong></span>
    </div>

    <button type="button" className="agent-main-card" onClick={onReturnMain}>
      <span className="agent-main-orb">π</span>
      <div>
        <span className="agent-card-source"><UserRound />父智能体· 主对话</span>
        <strong>主智能体</strong>
        <p>返回你正在进行的对话。父智能体负责拆分任务、等待子智能体，并汇总最终结果。</p>
        <span className="agent-main-return"><ArrowLeft />返回主对话</span>
      </div>
      <div className="agent-main-meta">
        <AgentMetric icon={<Cpu />} label="模型" value={selection.label || selection.modelRef || '—'} />
        <AgentMetric icon={<Sparkles />} label="思考" value={thinkingLabel(selection.effectiveThinkingLevel)} />
      </div>
    </button>

    {children.length > 0
      ? <section className="agent-child-grid" aria-label="子智能体列表">
        {children.map((child, index) => <ChildCard
          key={child.key}
          child={child}
          number={index + 1}
          now={now}
          onOpen={() => onOpenChild(child)}
          onDelete={() => onDeleteChild(child)}
          deleting={deletingChildKey === child.key}
        />)}
      </section>
      : <div className="agent-overview-empty">
        <GitFork />
        <strong>这次对话还没有子智能体</strong>
        <span>父智能体调用 subagent 工具后，运行记录会自动出现在这里。</span>
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
      .filter((message) => message.role === 'toolResult' && message.toolCallId)
      .map((message) => [message.toolCallId as string, message]),
  );
  const busy = child.status === 'running' || child.status === 'pending';
  return <div className="agent-context-view">
    <div className="agent-context-toolbar">
      <button type="button" className="agent-back-main" onClick={onBackMain}><ArrowLeft />返回主智能体</button>
      <nav className="agent-context-breadcrumb" aria-label="Agent 上下文路径">
        <button type="button" onClick={onOverview}>所有子智能体</button>
        <ChevronRight />
        <span>{child.name || child.agent} · {child.index + 1}</span>
      </nav>
      <button type="button" className="agent-context-overview" onClick={onOverview}><GitFork />总览</button>
    </div>

    <div className="agent-context-scroll">
      <div className="agent-context-column">
        <header className="agent-context-head">
          <span className="agent-context-avatar"><Bot /></span>
          <div>
            <span className="agent-overview-eyebrow">子 AGENT 会话</span>
            <h2>{child.name || child.agent}</h2>
            <p>{child.task || '这份子智能体会话没有可显示的任务说明。'}</p>
          </div>
          <span className={`agent-status is-${child.status}`}>{statusIcon(child.status)}<span>{STATUS_LABEL[child.status]}</span></span>
        </header>
        <div className="agent-context-meta">
          <span><Cpu /><small>模型</small><strong>{child.model || '继承父智能体'}</strong></span>
          <span><Sparkles /><small>思考强度</small><strong>{thinkingLabel(child.thinking)}</strong></span>
          <span><FolderGit2 /><small>上下文</small><strong>{contextLabel(child.context)}</strong></span>
          <span><Clock3 /><small>耗时</small><strong>{duration(child.durationMs)}</strong></span>
          <span><Terminal /><small>工具</small><strong>{child.toolCount ?? '—'}</strong></span>
          <span><MessageSquare /><small>Token 数</small><strong>{tokenCount(child.tokens)}</strong></span>
        </div>
        <div className="agent-readonly-note"><ShieldCheck /><span>只读上下文</span><p>这里展示子智能体自己的会话；不会向它发送消息，也不会改变父智能体的工作。</p></div>

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
          <span>子智能体可能尚未开始，或只产生了扩展状态记录。</span>
        </div>}
      </div>
    </div>
  </div>;
}
