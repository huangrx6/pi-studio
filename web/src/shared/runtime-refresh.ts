import type { RuntimeRefreshSnapshot } from '../types/runtime-types';

/**
 * Convert a persisted-but-not-loaded runtime refresh into one actionable
 * message. Saving can succeed while replacing a live extension fails, so the
 * UI must not present that state as a successful hot reload.
 */
export function runtimeRefreshFailure(
  refresh?: RuntimeRefreshSnapshot,
): string | null {
  if (!refresh) return null;
  const failed = refresh.status === 'error' || refresh.failedSessions > 0;
  if (!failed) return null;
  const detail = refresh.errors?.filter(Boolean).join('；')
    || refresh.message
    || '运行时没有应用新配置';
  return `配置已保存，但热加载失败：${detail}。请重新加载扩展或查看诊断。`;
}
