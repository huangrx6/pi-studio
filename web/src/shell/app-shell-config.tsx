import {
  ArchiveRestore, BarChart3, Bot, Code2, Cpu, HardDrive, Info, Keyboard, KeyRound,
  GitBranch, Globe, Package, Monitor, Settings, ShieldCheck, Wrench, AppWindow, Plug, FileCode2, Layers3,
} from 'lucide-react';

// Keep navigation to the noun labels users need to scan; each page's controls
// and layout carry the detail rather than repeating it as a sidebar subtitle.
// MCP / 技能 deep links stay valid as SettingsTab aliases and open the 插件 hub.
export const settingsPages = [
  // 先外观与输入，再模型与执行，再资源，最后工作区与应用数据。
  { id: 'general', group: '外观与输入', label: '通用', icon: Settings, keywords: ['外观', '主题', '背景', '壁纸', '终端', '托盘', '菜单栏', '字号', '圆角', '强调色'] },
  { id: 'shortcuts', group: '外观与输入', label: '快捷键', icon: Keyboard },
  { id: 'models', group: '模型与用量', label: '模型配置', icon: Cpu },
  { id: 'usage', group: '模型与用量', label: '使用量', icon: BarChart3, keywords: ['Token', '用量', '成本', '统计', 'Metrics', '采集', '已移除'] },
  { id: 'tools', group: '执行与权限', label: '智能体工具', icon: Wrench, keywords: ['工具方案', '内置工具', 'MCP', '临时对话'] },
  { id: 'permissions', group: '执行与权限', label: '权限策略', icon: ShieldCheck, keywords: ['批准', '规则', '安全', '权限方案', '临时对话'] },
  { id: 'harness', group: '执行与权限', label: 'Harness 配置', icon: Code2, keywords: ['提示词', '指令', '临时对话'] },
  { id: 'agents', group: '执行与权限', label: '智能体配置', icon: Bot, keywords: ['主对话', '临时对话', '子智能体', '子代理', '多智能体', 'agent', '装配'] },
  { id: 'plugins', group: '资源与扩展', label: '插件', icon: Package, keywords: ['Plugin', 'CLI', '插件包', '市场', '安装'] },
  { id: 'git', group: '工作区', label: 'Git 工作流', icon: GitBranch, keywords: ['Git 与 Worktree', '工作树', 'Git workflow', 'gitworkflow', '差异', '换行', '分支'] },
  { id: 'network', group: '数据与应用', label: '网络代理', icon: Globe, keywords: ['proxy', '代理', '网络', 'VPN', '连接', 'HTTP', 'SOCKS', '超时'] },
  { id: 'browser', group: '数据与应用', label: '浏览器', icon: AppWindow, keywords: ['Browser', 'CDP', 'Chrome', '下载', '历史', '网站权限', 'webview', '内嵌浏览器'] },
  { id: 'desktop-control', group: '数据与应用', label: '电脑操控', icon: Monitor, keywords: ['Desktop', 'Computer Use', '屏幕', '辅助功能', '窗口', '截图', '桌面', '只读'] },
  { id: 'secrets', group: '数据与应用', label: '测试凭据', icon: KeyRound, keywords: ['密钥', '令牌', '占位符', 'secret', 'token', '凭据引用'] },
  { id: 'archives', group: '数据与应用', label: '归档会话', icon: ArchiveRestore },
  { id: 'storage', group: '数据与应用', label: '设备存储', icon: HardDrive, keywords: ['storage', '磁盘', '硬盘', '空间', '占用', '缓存', '附件', '工作树', '数据目录', '数据库', '文件夹'] },
  { id: 'about', group: '数据与应用', label: '关于', icon: Info, keywords: ['版本', '更新', '许可', '诊断'] },
] as const;

export const pluginSettingsSearchPages = [
  { id: 'mcp', group: '资源与扩展', label: 'MCP 服务器', icon: Plug, keywords: ['插件', '连接', 'OAuth', '服务器'] },
  { id: 'skills', group: '资源与扩展', label: '技能', icon: FileCode2, keywords: ['插件', 'skill', '技能源', '技能市场'] },
  { id: 'extensions', group: '资源与扩展', label: '扩展', icon: Layers3, keywords: ['插件', 'extension', '声明式', '发布者'] },
] as const;

/** Sidebar page ids. */
export type SettingsNavTab = typeof settingsPages[number]['id'];
/**
 * Openable settings destinations. `mcp` / `skills` remain valid deep-link ids
 * and resolve into the unified 插件 hub via resolveSettingsDestination.
 */
export type SettingsTab = SettingsNavTab | 'mcp' | 'skills' | 'extensions' | 'harness-compaction' | 'subagents' | 'subagent-worktrees' | 'temporary-chat' | 'main-agent';

/** Sub-tabs inside 设置 → 插件. */
export type PluginWorkspaceSection = 'plugins' | 'mcp' | 'skills' | 'extensions';

/** Sub-tabs inside 设置 → 智能体配置. */
export type AgentConfigSection = 'main' | 'temporary' | 'subagents';

export type SettingsDestination = {
  tab: SettingsNavTab;
  pluginSection?: PluginWorkspaceSection;
  agentSection?: AgentConfigSection;
  anchor?: 'harness-compaction' | 'subagent-worktrees';
};

/** Resolve settings shortcuts to a page and its destination within that page. */
export function resolveSettingsDestination(tab: SettingsTab): SettingsDestination {
  if (tab === 'mcp' || tab === 'skills' || tab === 'extensions') {
    return { tab: 'plugins', pluginSection: tab };
  }
  if (tab === 'harness-compaction') return { tab: 'harness', anchor: tab };
  if (tab === 'subagent-worktrees') return { tab: 'agents', agentSection: 'subagents', anchor: tab };
  if (tab === 'subagents') return { tab: 'agents', agentSection: 'subagents' };
  if (tab === 'temporary-chat') return { tab: 'agents', agentSection: 'temporary' };
  if (tab === 'main-agent') return { tab: 'agents', agentSection: 'main' };
  if (tab === 'agents') return { tab: 'agents', agentSection: 'main' };
  // Always land on the default 插件 tab when opening 插件 from navigation;
  // mcp / skills / extensions deep links resolve above to their target tab.
  if (tab === 'plugins') return { tab: 'plugins', pluginSection: 'plugins' };
  return { tab };
}

export function isPluginWorkspaceTab(tab: SettingsTab): boolean {
  return tab === 'plugins' || tab === 'mcp' || tab === 'skills' || tab === 'extensions';
}

// 新增模型来源时可选的上游 API 协议。
export const apiTypeOptions = [
  { value: 'openai-completions', label: 'OpenAI Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
];

// 输入框左侧的权限模式；Durable 权限 hook 在每次工具调用前读取 SQLite。
export const permissionOptions = [
  { value: 'ask', label: '请求批准', description: '编辑文件或联网前询问' },
  { value: 'smart', label: '帮我批准', description: '仅对风险操作请求批准' },
  { value: 'full', label: '完全权限', description: '不再询问，直接执行' },
];

export type PermissionMode = 'ask' | 'smart' | 'full';
export type PermissionUiState = {
  scopeKey: string;
  available: boolean;
  mode: PermissionMode;
  status: 'loading' | 'ready' | 'error';
};

export const EMPTY_PERMISSION_UI_STATE: PermissionUiState = {
  scopeKey: '',
  available: false,
  mode: 'smart',
  status: 'loading',
};

export function permissionScopeKey(cwd: string, sessionId?: string): string {
  return `${cwd}\u0000${sessionId || ''}`;
}

export function BrandMark({ className = '' }: { className?: string }) {
  return <span className={`brand-mark pi-mark ${className}`.trim()} aria-hidden="true" />;
}
