import { Check, CircleAlert, LoaderCircle, Pause, Play, Target } from 'lucide-react';
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
  if (status === 'completed') return <Check aria-hidden="true" />;
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
}: {
  state: LongTaskState | undefined;
  running: boolean;
  busy: boolean;
  onChange: (action: 'long-task-pause' | 'long-task-resume') => void;
}) {
  if (!state?.enabled && !state?.goal) return null;
  const status = state.status;
  const detail = status === 'blocked'
    ? state.blockReason
    : status === 'completed'
      ? state.completionSummary
      : state.nextStep || state.lastProgress;
  const canResume = status !== 'active' || !running;
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
      {canResume && (
        <button
          type="button"
          className="long-task-action"
          disabled={busy}
          onClick={() => onChange('long-task-resume')}
        >
          {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
          {status === 'active' ? '继续执行' : '继续目标'}
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
