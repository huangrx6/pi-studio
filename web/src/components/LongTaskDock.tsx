import { CircleAlert, LoaderCircle, Pause, PencilLine, Play, Target } from 'lucide-react';
import type { LongTaskState } from '../types/durable-types';

const STATUS_LABELS: Record<LongTaskState['status'], string> = {
  idle: '等待目标',
  active: '目标执行中',
  paused: '已暂停',
  blocked: '等待补充',
  completed: '已完成',
  failed: '执行失败',
};

function statusIcon(status: LongTaskState['status']) {
  if (status === 'blocked') return <CircleAlert aria-hidden="true" />;
  if (status === 'paused') return <Pause aria-hidden="true" />;
  if (status === 'active') return <Target aria-hidden="true" />;
  return <CircleAlert aria-hidden="true" />;
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
  if (!state?.enabled && !state?.goal) return null;
  const status = state.status;
  // Completion already has a durable transcript result. Keeping a second dock
  // above the composer would permanently consume space after the goal ends.
  if (status === 'completed') return null;
  const detail = status === 'blocked'
    ? state.blockReason
    : status === 'paused'
      ? state.pauseReason || state.nextStep || state.lastProgress
      : state.nextStep || state.lastProgress;
  const canResume = status === 'paused'
    || status === 'blocked'
    || (status === 'active' && !running);
  return (
    <div className={`long-task-dock is-${status}`} role="status">
      <div className="long-task-status">
        <span className="long-task-icon">
          {running && status === 'active'
            ? <LoaderCircle className="spin" aria-hidden="true" />
            : statusIcon(status)}
        </span>
        <span className="long-task-copy">
          <span className="long-task-heading">
            <strong>{STATUS_LABELS[status]}</strong>
            {state.iteration > 0 && <small>{state.iteration} 轮进展</small>}
          </span>
          <span className="long-task-goal" title={detail || state.goal}>
            {detail || state.goal}
          </span>
        </span>
      </div>
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
      {canResume && (
        <button
          type="button"
          className="long-task-action"
          disabled={busy}
          onClick={() => onChange('long-task-resume')}
        >
          {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
          继续
        </button>
      )}
      {running && status === 'active' && (
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
  );
}
