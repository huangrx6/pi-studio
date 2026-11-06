import { useId, useState } from 'react';
import { ChevronDown, CircleAlert, LoaderCircle, Pause, PencilLine, Play, Target } from 'lucide-react';
import type { LongTaskState } from '../../types/durable-types';
import { isLongTaskDetailLong, longTaskPresentation } from './long-task-presentation';
import './long-task-dock.css';

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
  running,
  busy,
  onChange,
  onEditGoal,
}: {
  state: LongTaskState | undefined;
  running: boolean;
  busy: boolean;
  onChange: (action: 'long-task-pause' | 'long-task-resume') => void;
  onEditGoal: () => void;
}) {
  const presentation = longTaskPresentation(state, running);
  if (!state || !presentation) return null;
  const status = state.status;
  return (
    <div className={`long-task-dock is-${status}`} aria-busy={busy}>
      <div className="long-task-status">
        <span className="long-task-icon">
          {presentation.isRunning
            ? <LoaderCircle className="spin" aria-hidden="true" />
            : statusIcon(status)}
        </span>
        <div className="long-task-copy">
          <span className="long-task-heading" role="status">
            <strong>{presentation.label}</strong>
            {state.iteration > 0 && <small>已记录 {state.iteration} 次进展</small>}
          </span>
          <LongTaskDetails key={state.goal} goal={presentation.goal} detail={presentation.detail} />
        </div>
      </div>
      <div className="long-task-actions">
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
      </div>
    </div>
  );
}
