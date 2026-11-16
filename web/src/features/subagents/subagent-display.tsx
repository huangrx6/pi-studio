import { CheckCircle2, CircleStop, CircleX, MessageSquare, Pause } from 'lucide-react';
import { LoadingIndicator } from '../../shared/LoadingState';
import type { SubagentChild } from '../../types/subagent-types';

export const STATUS_LABEL: Record<SubagentChild['status'], string> = {
  pending: '等待启动',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  paused: '已暂停',
  waiting: '等待回复',
};

export function duration(value?: number): string {
  if (value === undefined || value < 0) return '—';
  if (value < 1_000) return `${value}ms`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function liveDuration(child: SubagentChild, now: number): number | undefined {
  if (typeof child.durationMs === 'number') return child.durationMs;
  if (child.startedAt !== undefined && ['running', 'pending', 'waiting'].includes(child.status)) {
    return Math.max(0, now - child.startedAt);
  }
  return undefined;
}

export function tokenCount(value?: number): string {
  if (value === undefined) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

export function statusIcon(status: SubagentChild['status']) {
  if (status === 'running' || status === 'pending') return <LoadingIndicator />;
  if (status === 'waiting') return <MessageSquare />;
  if (status === 'failed') return <CircleX />;
  if (status === 'stopped') return <CircleStop />;
  if (status === 'paused') return <Pause />;
  return <CheckCircle2 />;
}

export function needsAttention(child: SubagentChild): boolean {
  const { status } = child;
  return Boolean(child.supervisorRequests?.length) || status === 'waiting' || status === 'failed' || status === 'paused';
}

export function isActive(status: SubagentChild['status']): boolean {
  return status === 'running' || status === 'pending';
}

export function hasEnded(status: SubagentChild['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}
