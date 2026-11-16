import { createContext, useContext } from 'react';
import { Activity, BarChart3, Cloud, Cpu, Database, Gauge, Layers3, Plug, Terminal, Timer, Wallet, Zap, type LucideIcon } from 'lucide-react';
import { statusAppearance, type AppearanceOverrides, type StatusAppearance, type StatusPanel } from '../../shared/extension-appearance';

const icons = {
  activity: Activity, gauge: Gauge, timer: Timer, terminal: Terminal, chart: BarChart3,
  wallet: Wallet, database: Database, cloud: Cloud, cpu: Cpu, layers: Layers3, plug: Plug, zap: Zap,
} satisfies Record<StatusAppearance['icon'], LucideIcon>;

export const ExtensionAppearanceContext = createContext<AppearanceOverrides>({});

export function StatusGlyph({ icon, color }: StatusAppearance) {
  const Icon = icons[icon];
  return <Icon className="extension-status-glyph" data-icon={icon} data-color={color} aria-hidden="true"
    style={{ color: `var(--extension-icon-${color})` }} />;
}

export function ExtensionStatusIcon({ item }: { item: StatusPanel }) {
  const overrides = useContext(ExtensionAppearanceContext);
  return <StatusGlyph {...statusAppearance(item, overrides[item.id])} />;
}
