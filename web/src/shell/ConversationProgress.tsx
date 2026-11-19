import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownUp, ChevronDown, ChevronRight, ChevronUp, FileDiff, GitBranch, GitCommitHorizontal, History, ListChecks, Pin, PinOff, Settings2, Target } from 'lucide-react';
import { LongTaskDock } from '../features/conversation/LongTaskDock';
import { longTaskPresentation } from '../features/conversation/long-task-presentation';
import { TodoDock } from '../features/conversation/TodoDock';
import { TodoHistory } from '../features/conversation/TodoHistory';
import { STATUS_LABEL } from '../features/subagents/subagent-display';
import { SubagentAvatar } from '../features/subagents/SubagentAvatar';
import { orderProgressAgents } from '../features/subagents/subagent-state';
import type { TodoDetails } from '../types/chat-types';
import type { LongTaskState } from '../types/durable-types';
import type { GitWorkspaceStatus, GitTab } from '../types/git-types';
import { useGitRepositories } from '../features/git/useWorkspaceRepositories';
import type { SubagentChild } from '../types/subagent-types';
import './styles/conversation-progress.css';

function ProgressTriggerComponent({ open, pinned, active, onToggle, onDismiss, children }: {
  open: boolean;
  pinned: boolean;
  active: boolean;
  onToggle: () => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) onDismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      onDismiss();
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, onDismiss]);

  return <div ref={root} className="workspace-menu-anchor">
    <button ref={trigger} type="button" className={`icon-button progress-trigger ${open || active ? 'is-active' : ''}`}
      aria-label="打开会话进展" title={pinned ? '在右栏查看会话进展' : '会话进展'} aria-haspopup={pinned ? undefined : 'dialog'}
      aria-controls={open ? dialogId : undefined} aria-expanded={open || active} onClick={onToggle}><ListChecks /></button>
    {open && <section className="workspace-menu progress-popover" role="dialog" aria-label="会话进展" id={dialogId}>
      {children}
    </section>}
  </div>;
}

type ProgressProps = {
  pinned: boolean;
  onPinChange: () => void;
  sessionId?: string;
  git: GitWorkspaceStatus | null;
  onGitSettings: () => void;
  onOpenGit: (tab: GitTab) => void;
  goal?: LongTaskState;
  running: boolean;
  goalBusy: boolean;
  onGoalAction: (action: 'long-task-pause' | 'long-task-resume') => void;
  onEditGoal: () => void;
  tasks?: TodoDetails;
  history: boolean;
  onToggleHistory: () => void;
  onOpenTasks: () => void;
  agents: SubagentChild[];
  onAgents: () => void;
  onAgent: (child: SubagentChild) => void;
};

function ViewAll({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="progress-view-all" aria-label={label} onClick={onClick}>查看全部<ChevronRight aria-hidden="true" /></button>;
}

const ProgressAgentRow = memo(function ProgressAgentRow({
  child,
  onAgent,
}: {
  child: SubagentChild;
  onAgent: (child: SubagentChild) => void;
}) {
  return <button type="button" className="progress-row progress-agent"
    data-status={child.status} onClick={() => onAgent(child)}>
    <SubagentAvatar id={child.avatarId} /><span title={child.task}>{child.name || child.agent}</span>
    <small>{STATUS_LABEL[child.status]}</small>
  </button>;
});

const ProgressGitSection = memo(function ProgressGitSection({
  git,
  onGitSettings,
  onOpenGit,
}: {
  git: GitWorkspaceStatus | null;
  onGitSettings: () => void;
  onOpenGit: (tab: GitTab) => void;
}) {
  const scope = useGitRepositories();
  const branch = git?.branch || git?.commit || '当前仓库';
  const project = scope.selected?.id === '.' ? (scope.repositories.length > 1 ? scope.selected.name : '') : scope.selected?.id;
  let repositoryLabel = [project, branch].filter(Boolean).join(' · ');
  if (!scope.selected) repositoryLabel = scope.loading ? '正在查找项目仓库…' : scope.error ? '仓库读取失败' : '没有 Git 仓库';
  else if (!git) repositoryLabel = '正在读取 Git 状态…';
  else if (!git.available) repositoryLabel = 'Git 不可用';
  return <section className="workspace-menu-section progress-git" aria-label="Git 工具" data-available={git?.available || undefined}>
    <header className="progress-git-repo">
      <div className="progress-git-identity">
        <div className="progress-git-title"><GitBranch aria-hidden="true" /><span className={git?.available ? 'progress-git-branch' : undefined} title={[repositoryLabel, git?.repositoryRoot].filter(Boolean).join('\n')}>{repositoryLabel}</span></div>
        {git?.available && <small>{git.statusReadFailed ? '未能读取变更' : git.dirty.total ? `${git.dirty.total} 项变更` : '工作区干净'}</small>}
      </div>
      <button className="icon-button" type="button" aria-label="Git 设置" title="Git 设置" onClick={onGitSettings}><Settings2 aria-hidden="true" /></button>
    </header>
    {git?.available ? <nav className="progress-git-links" aria-label="Git 操作">
      <button type="button" onClick={() => onOpenGit('changes')}><FileDiff aria-hidden="true" />变更</button>
      <button type="button" onClick={() => onOpenGit('commit')}><GitCommitHorizontal aria-hidden="true" />提交</button>
      <button type="button" onClick={() => onOpenGit('history')}><History aria-hidden="true" />提交历史</button>
      <button type="button" onClick={() => onOpenGit('sync')}><ArrowDownUp aria-hidden="true" />远程同步</button>
    </nav> : !!scope.cwd && !scope.loading && <button type="button" className="progress-row" onClick={() => onOpenGit('changes')}><GitBranch /><span>查看项目仓库</span><ChevronRight /></button>}
  </section>;
});

function ConversationProgressView(props: ProgressProps) {
  const { pinned, git, sessionId, goal, running, tasks, agents, history } = props;
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const agentsId = useId();
  const historyId = useId();
  const orderedAgents = useMemo(() => orderProgressAgents(agents), [agents]);
  const previewLimit = 3;
  const visibleAgents = agentsExpanded ? orderedAgents : orderedAgents.slice(0, previewLimit);
  const pinLabel = pinned ? '取消固定，返回浮层' : '固定到右栏';
  const historyLabel = history ? '收起历史' : '查看历史';
  const allTasks = <ViewAll label="查看全部任务" onClick={props.onOpenTasks} />;
  const gitSection = <ProgressGitSection git={git} onGitSettings={props.onGitSettings} onOpenGit={props.onOpenGit} />;
  return <div className={`conversation-progress ${pinned ? 'is-pinned' : ''}`}>
    <header className="workspace-menu-head progress-head">
      <strong>会话进展</strong>
      <button type="button" className="icon-button progress-pin" title={pinLabel} aria-label={pinLabel}
        onClick={props.onPinChange}>{pinned ? <PinOff /> : <Pin />}</button>
    </header>
    {!sessionId ? <p className="progress-empty">选择一个会话查看进展</p> : <>
      {!pinned && gitSection}
      <section className="workspace-menu-section progress-goal" aria-label="目标任务">
        {!pinned && <span className="workspace-menu-section-label">目标任务</span>}
        {longTaskPresentation(goal, running)
          ? <LongTaskDock key={goal?.goalId || goal?.goal} state={goal} running={running} featured={pinned} busy={props.goalBusy} onChange={props.onGoalAction} onEditGoal={props.onEditGoal} />
          : <button type="button" className="progress-row" onClick={props.onEditGoal}><Target /><span>设置目标</span><ChevronRight /></button>}
      </section>
      <section className="workspace-menu-section progress-tasks" aria-label="任务列表">
        {!pinned && <header className="progress-section-head"><h3>任务列表</h3>{allTasks}</header>}
        <TodoDock key={tasks?.planId} details={tasks} pinnedHeaderAction={pinned ? allTasks : undefined} />
        <button type="button" className="progress-history-toggle" aria-expanded={history} aria-controls={historyId}
          aria-label={historyLabel} onClick={props.onToggleHistory}><ChevronRight aria-hidden="true" />历史清单</button>
        <div id={historyId} hidden={!history}>{history && <TodoHistory key={sessionId} sessionId={sessionId} goalUpdatedAt={goal?.updatedAt} />}</div>
      </section>
      <section className="workspace-menu-section progress-agents" aria-label="子智能体">
        <header className="progress-section-head">
          <h3>子智能体{agents.length > 0 && <small>{agents.length}</small>}</h3>
          <ViewAll label="查看全部子智能体" onClick={props.onAgents} />
        </header>
        {!!agents.length && <div className="progress-agent-list" id={agentsId} tabIndex={agentsExpanded ? 0 : undefined}>
          {visibleAgents.map(child => <ProgressAgentRow key={child.key} child={child} onAgent={props.onAgent} />)}
        </div>}
        {agents.length > previewLimit && <button type="button" className="progress-text-action progress-agents-more"
          aria-controls={agentsId} aria-expanded={agentsExpanded} onClick={() => setAgentsExpanded(value => !value)}>
          {agentsExpanded ? '收起子智能体' : `展开其余 ${agents.length - previewLimit} 个子智能体`}
          {agentsExpanded ? <ChevronUp /> : <ChevronDown />}
        </button>}
      </section>
      {pinned && gitSection}
    </>}
  </div>;
}


export const ProgressTrigger = memo(ProgressTriggerComponent);

export const ConversationProgress = memo(ConversationProgressView);
