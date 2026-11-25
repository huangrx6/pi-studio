import { FileCode2, Layers3, Package, Plug, type LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { InfoHint } from '../../shared/InfoHint';
import { SettingsPageHeader } from '../../shared/SettingsPageHeader';
import type { PluginWorkspaceSection } from '../../shell/app-shell-config';
import { SettingsTabs } from '../../shared/SettingsTabs';
import './styles/plugin-workspace.css';

const SECTIONS: ReadonlyArray<{
  value: PluginWorkspaceSection;
  label: string;
  title: string;
  description: string;
  hint?: string;
  icon: LucideIcon;
}> = [
  { value: 'plugins', label: '插件', title: '插件', icon: Package, description: '安装和管理包含 MCP、技能、命令行或界面扩展的插件包。' },
  { value: 'mcp', label: 'MCP', title: 'MCP 服务器', icon: Plug, description: '连接外部工具服务，启停从下一次请求生效。',
    hint: '打开服务器详情可启停单个方法。默认通过 tool_search 按需发现。' },
  { value: 'skills', label: '技能', title: '技能', icon: FileCode2, description: '管理已安装的技能和技能源。',
    hint: '可用技能默认由模型按需发现。标为「仅显式调用」的技能需手动引用。项目技能须先信任，目录内容变化后需重新信任。配置在下一次请求前生效。' },
  { value: 'extensions', label: '扩展', title: '扩展', icon: Layers3, description: '管理已安装的扩展和受信任的发布者。',
    hint: '全局扩展安装后默认信任。项目扩展需要手动信任后才能加载可执行代码。' },
];

export function PluginWorkspaceHeader({
  id,
  section,
  actions,
  actionsRef,
  onChange,
}: {
  id: string;
  section: PluginWorkspaceSection;
  actions?: ReactNode;
  actionsRef?: Ref<HTMLDivElement>;
  onChange: (section: PluginWorkspaceSection) => void;
}) {
  const { title, description, hint, icon: Icon } = SECTIONS.find(item => item.value === section) ?? SECTIONS[0];
  return <>
    <SettingsPageHeader title={title} iconPosition="end" icon={<Icon />}
      meta={<><span>{description}</span>{hint && <InfoHint label={hint} />}</>} />
    <div className="plugin-workspace-toolbar">
      <SettingsTabs id={id} label="插件与资源" tabs={SECTIONS} value={section} onChange={onChange} />
      {(actions || actionsRef) && <div ref={actionsRef} className="plugin-workspace-actions" role="group" aria-label={`${title}操作`}>{actions}</div>}
    </div>
  </>;
}

export function PluginWorkspaceAction({ label, ariaLabel = label, icon, primary, ...buttonProps }: {
  label: string;
  ariaLabel?: string;
  icon: ReactNode;
  primary?: boolean;
} & Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled' | 'onClick' | 'aria-haspopup' | 'aria-expanded'>) {
  return <button type="button" className={primary ? 'settings-add-button' : 'settings-outline'}
    title={ariaLabel} aria-label={ariaLabel} {...buttonProps}>
    {icon}<span>{label}</span>
  </button>;
}
