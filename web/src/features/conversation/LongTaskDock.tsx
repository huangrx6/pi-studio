import { useId, useState } from 'react';
import { ChevronDown, CircleAlert, Pause, PencilLine, Play, Target } from 'lucide-react';
import { LoadingIndicator } from '../../shared/LoadingState';
import type { LongTaskState } from '../../types/durable-types';
import { isLongTaskDetailLong, longTaskPresentation } from './long-task-presentation';
import './styles/long-task-dock.css';

function statusIcon(status: LongTaskState['status']) {
  if (status === 'blocked') return <CircleAlert aria-hidden="true" />;
  if (status === 'paused') return <Pause aria-hidden="true" />;
  if (status === 'active') return <Target aria-hidden="true" />;
  return <CircleAlert aria-hidden="true" />;
}

function LongTaskDetails({ goal, detail }: { goal: string; detail: string }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const longGoal = isLongTaskDetailLong(goal);
  const longDetail = isLongTaskDetailLong(detail);
  return <>
    <div id={contentId} className={`long-task-content ${expanded ? 'is-expanded' : ''}`}
      role="region" aria-label="长期目标与说明" tabIndex={expanded ? 0 : undefined}>
      <p className={`long-task-goal ${longGoal ? 'is-truncated' : ''}`}>{goal}</p>
      {detail && <p className={`long-task-detail ${longDetail ? 'is-truncated' : ''}`}>{detail}</p>}
    </div>
    {(longGoal || longDetail) && <button type="button" className="long-task-details-toggle"
      aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
      {expanded ? '收起详情' : '展开详情'}<ChevronDown aria-hidden="true" />
    </button>}
  </>;
}

export function LongTaskDock({
  state,
  featured = false,
  running,
  busy,
  onChange,
  onEditGoal,
}: {
  state: LongTaskState | undefined;
  featured?: boolean;
  running: boolean;
  busy: boolean;
  onChange: (action: 'long-task-pause' | 'long-task-resume') => void;
  onEditGoal: () => void;
}) {
  const [progressOpen, setProgressOpen] = useState(false);
  const progressId = useId();
  const presentation = longTaskPresentation(state, running);
  if (!state || !presentation) return null;
  const status = state.status;
  const statusLabel = <span className="long-task-heading" role="status">
    <strong>{presentation.label}</strong>
    {!featured && state.iteration > 0 && <small>已记录 {state.iteration} 次进展</small>}
  </span>;
  const needsAttention = status === 'blocked' || status === 'failed';
  const progressNote = featured && !needsAttention ? presentation.detail : '';
  const hasProgress = state.iteration > 0 || Boolean(progressNote);
  const details = <LongTaskDetails key={state.goal} goal={presentation.goal} detail={featured && !needsAttention ? '' : presentation.detail} />;
  return (
    <div className={`long-task-dock is-${status} ${featured ? 'is-featured' : ''}`} aria-busy={busy}>
      {featured ? <>
        <header className="progress-goal-head"><span><Target />当前目标</span>
          {hasProgress ? <button type="button" className="progress-goal-state" aria-expanded={progressOpen} aria-controls={progressId}
            title="目标进展详情" onClick={() => setProgressOpen(value => !value)}>
            {presentation.label}<ChevronDown aria-hidden="true" /></button> : statusLabel}
        </header>
        {details}
        {hasProgress && <div id={progressId} className="progress-goal-note" hidden={!progressOpen}>
          {progressNote && <p>{progressNote}</p>}
          {state.iteration > 0 && <small>已记录 {state.iteration} 次进展</small>}
        </div>}
      </> : <div className="long-task-status">
        <span className="long-task-icon">{presentation.isRunning ? <LoadingIndicator /> : statusIcon(status)}</span>
        <div className="long-task-copy">{statusLabel}{details}</div>
      </div>}
      <div className="long-task-actions">
        {presentation.canResume && (
          <button
            type="button"
            className="long-task-action"
            disabled={busy}
            title={status === 'blocked' ? '处理阻塞原因后继续目标' : '继续当前目标'}
            onClick={() => onChange('long-task-resume')}
          >
            <Play aria-hidden="true" />
            继续
          </button>
        )}
        {presentation.canPause && (
          <button
            type="button"
            className="long-task-action is-quiet"
            disabled={busy}
            onClick={() => onChange('long-task-pause')}
          >
            <Pause aria-hidden="true" />
            暂停
          </button>
        )}
        <button
          type="button"
          className="long-task-action is-quiet"
          disabled={busy}
          title="换目标（/goal）"
          onClick={onEditGoal}
        >
          <PencilLine aria-hidden="true" />
          换目标
        </button>
      </div>
    </div>
  );
}
