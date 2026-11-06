import type { LongTaskState } from '../../types/durable-types';

/** Presentation follows the supported longTaskPause/longTaskResume commands. */
export function longTaskPresentation(state: LongTaskState | undefined, running: boolean) {
  if (!state || (!state.enabled && !state.goal) || state.status === 'completed') return null;
  const goal = state.goal.trim();
  const actionable = state.enabled && Boolean(goal);
  const isRunning = actionable && state.status === 'active' && running;
  const labels: Record<LongTaskState['status'], string> = {
    idle: '等待目标',
    active: isRunning ? '目标执行中' : '等待继续',
    paused: '已暂停',
    blocked: '等待处理',
    completed: '已完成',
    failed: '执行失败',
  };
  let detail = '';
  if (actionable) {
    switch (state.status) {
      case 'blocked':
        detail = state.blockReason.trim() || '请先处理阻塞原因，再继续目标。';
        break;
      case 'paused':
        detail = state.pauseReason.trim() || '目标已暂停，可在准备好后继续。';
        break;
      case 'failed':
        // The public state has no failure-reason field. Old progress/nextStep
        // describes earlier work and must never be presented as the failure.
        detail = '请查看对话中的错误信息，或设置新目标。';
        break;
      case 'active':
        detail = state.nextStep.trim() ? `下一步：${state.nextStep.trim()}`
          : state.lastProgress.trim() ? `最近进展：${state.lastProgress.trim()}`
            : isRunning ? '' : '继续后将推进当前目标。';
        break;
    }
  }
  return {
    label: !goal ? '等待目标' : !state.enabled ? '目标未启用' : labels[state.status],
    goal: goal || '设置一个目标，让 Pi 持续推进。',
    detail,
    isRunning,
    canResume: actionable && (state.status === 'paused' || state.status === 'blocked' || (state.status === 'active' && !running)),
    canPause: actionable && (state.status === 'active' || state.status === 'blocked'),
  };
}

/** Short content wraps fully; only content with an expansion control is clamped. */
export function isLongTaskDetailLong(text: string) {
  return text.length > 80 || text.includes('\n');
}
