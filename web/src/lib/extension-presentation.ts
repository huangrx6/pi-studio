import type { ExtensionHostItem } from '../types/extension-types';

export function extensionScopeLabel(scope: ExtensionHostItem['scope']): string {
  if (scope === 'builtin') return '内置';
  if (scope === 'project') return '当前工作区';
  return '全局';
}

export function extensionStateLabel(item: ExtensionHostItem): string {
  if (!item.enabled) return '已停用';
  if (!item.trusted) return '等待信任';
  if (item.health === 'cycle') return '依赖循环';
  if (item.health === 'error') return '加载失败';
  if (item.health === 'blocked' || item.health === 'missing') return '依赖异常';
  if (!item.available) return '不可用';
  return '运行中';
}

export function extensionTierLabel(tier: ExtensionHostItem['tier']): string {
  if (tier === 'core') return '核心';
  if (tier === 'system') return '系统';
  if (tier === 'optional') return '可选';
  return extensionScopeLabel(tier);
}

export function extensionContributionCount(item: ExtensionHostItem): number {
  const contributes = item.manifest?.contributes;
  if (!contributes) return 0;
  return (contributes.tools?.length || 0)
    + (contributes.commands?.length || 0)
    + (contributes.panels?.length || 0)
    + (contributes.settings?.length || 0)
    + (contributes.composer?.length || 0)
    + (contributes.dataSources?.length || 0);
}

export function extensionStateTone(item: ExtensionHostItem): 'ready' | 'pending' | 'error' {
  if (item.available) return 'ready';
  if (!item.trusted || !item.enabled) return 'pending';
  return 'error';
}
