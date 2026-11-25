import { memo, useId, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, History, Target } from 'lucide-react';
import { LongTaskDock } from '../features/conversation/LongTaskDock';
import { longTaskPresentation } from '../features/conversation/long-task-presentation';
import { TodoDock } from '../features/conversation/TodoDock';
import { STATUS_LABEL } from '../features/subagents/subagent-display';
import { SubagentAvatar } from '../features/subagents/SubagentAvatar';
import { orderProgressAgents } from '../features/subagents/subagent-state';
import type { TodoDetails } from '../types/chat-types';
import type { LongTaskState } from '../types/durable-types';
import type { SubagentChild } from '../types/subagent-types';
import './styles/conversation-progress.css';

type ProgressProps = {
  sessionId?: string;
  goal?: LongTaskState;
  running: boolean;
  goalBusy: boolean;
  onGoalAction: (action: 'long-task-pause' | 'long-task-resume') => void;
  onEditGoal: () => void;
  tasks?: TodoDetails;
  onOpenTasks: () => void;
  onOpenHistory: () => void;
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

function ConversationProgressView(props: ProgressProps) {
  const { sessionId, goal, running, tasks, agents } = props;
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const agentsId = useId();
  const orderedAgents = useMemo(() => orderProgressAgents(agents), [agents]);
  const previewLimit = 3;
  const visibleAgents = agentsExpanded ? orderedAgents : orderedAgents.slice(0, previewLimit);
  const allTasks = <ViewAll label="查看全部任务" onClick={props.onOpenTasks} />;
  return <div className="conversation-progress">
    <header className="progress-head"><strong>会话进展</strong></header>
    {!sessionId ? <p className="progress-empty">选择一个会话查看进展</p> : <>
      <section className="progress-goal" aria-label="目标任务">
        {longTaskPresentation(goal, running)
          ? <LongTaskDock key={goal?.goalId || goal?.goal} state={goal} running={running} featured busy={props.goalBusy} onChange={props.onGoalAction} onEditGoal={props.onEditGoal} />
          : <button type="button" className="progress-row" onClick={props.onEditGoal}><Target /><span>设置目标</span><ChevronRight /></button>}
      </section>
      <section className="progress-tasks" aria-label="任务列表">
        <TodoDock key={tasks?.planId} details={tasks} headerAction={allTasks} />
        <button type="button" className="progress-history-toggle" onClick={props.onOpenHistory}><History aria-hidden="true" />历史清单</button>
      </section>
      <section className="progress-agents" aria-label="子智能体">
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
    </>}
  </div>;
}


export const ConversationProgress = memo(ConversationProgressView);
