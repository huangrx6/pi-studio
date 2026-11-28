import type { ExtensionIconColor, ExtensionUiSlot } from '../types/extension-types';

export const iconLabels = {
  activity: '波形', gauge: '仪表盘', timer: '计时器', terminal: '终端', chart: '柱状图',
  wallet: '钱包', database: '数据库', cloud: '云', coffee: '咖啡杯', cpu: '芯片', layers: '图层', plug: '插头', zap: '闪电',
} as const;
export const colorLabels = {
  neutral: '中性', accent: '主题强调色', info: '信息蓝', success: '成功绿', warning: '琥珀黄', error: '提示红',
} satisfies Record<ExtensionIconColor, string>;
export type StatusIconName = keyof typeof iconLabels;
export type StatusAppearance = { icon: StatusIconName; color: ExtensionIconColor };
export type AppearanceOverrides = Record<string, Partial<StatusAppearance>>;
export type StatusPanel = { id: string; icon?: string; color?: ExtensionIconColor; slot?: ExtensionUiSlot; iconDataUrl?: string };

function iconName(value: unknown): StatusIconName | undefined {
  if (value === 'pulse') return 'activity';
  return typeof value === 'string' && Object.hasOwn(iconLabels, value) ? value as StatusIconName : undefined;
}
function colorName(value: unknown): ExtensionIconColor | undefined {
  return typeof value === 'string' && Object.hasOwn(colorLabels, value) ? value as ExtensionIconColor : undefined;
}

export function statusIconDataUrl(panel: StatusPanel, override?: Partial<StatusAppearance>): string | undefined {
  const source = panel.iconDataUrl;
  return source?.startsWith('data:image/png;base64,') && !iconName(override?.icon) ? source : undefined;
}

export function statusAppearance(panel: StatusPanel, override?: Partial<StatusAppearance>): StatusAppearance {
  return {
    icon: iconName(override?.icon) ?? iconName(panel.icon) ?? ((panel.slot === 'tool.view' || panel.slot === 'status.detail') ? 'plug' : 'activity'),
    color: colorName(override?.color) ?? colorName(panel.color) ?? 'neutral',
  };
}

export function normalizeAppearanceOverrides(value: unknown): AppearanceOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: AppearanceOverrides = {};
  for (const [id, override] of Object.entries(value)) {
    if (!/^(builtin|user|project):[a-z0-9][a-z0-9._-]{1,63}\/[a-z0-9][a-z0-9._-]{0,63}$/.test(id)
      || !override || typeof override !== 'object') continue;
    const icon = iconName(override.icon);
    const color = colorName(override.color);
    if (icon || color) result[id] = { ...(icon && { icon }), ...(color && { color }) };
  }
  return result;
}
