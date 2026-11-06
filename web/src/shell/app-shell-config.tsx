import {
  ArchiveRestore, BarChart3, Bot, Code2, Cpu, FileCode2, Info, Keyboard,
  Layers3, Plug, Settings, ShieldCheck, Wrench,
} from 'lucide-react';
import appIcon from '../../../assets/icon.png';

// Keep navigation to the noun labels users need to scan; each page's controls
// and layout carry the detail rather than repeating it as a sidebar subtitle.
export const settingsPages = [
  { id: 'general', group: '外观与输入', label: '通用', icon: Settings },
  { id: 'shortcuts', group: '外观与输入', label: '快捷键', icon: Keyboard },
  { id: 'models', group: '模型与用量', label: '模型配置', icon: Cpu },
  { id: 'usage', group: '模型与用量', label: '使用量', icon: BarChart3 },
  { id: 'tools', group: '执行与权限', label: '智能体工具', icon: Wrench },
  { id: 'permissions', group: '执行与权限', label: '权限策略', icon: ShieldCheck },
  { id: 'harness', group: '执行与权限', label: 'Harness 配置', icon: Code2 },
  { id: 'subagents', group: '执行与权限', label: '子智能体', icon: Bot },
  { id: 'mcp', group: '资源与扩展', label: 'MCP 服务器', icon: Plug },
  { id: 'skills', group: '资源与扩展', label: '技能', icon: FileCode2 },
  { id: 'extensions', group: '资源与扩展', label: '扩展', icon: Layers3 },
  { id: 'archives', group: '数据与应用', label: '归档会话', icon: ArchiveRestore },
  { id: 'about', group: '数据与应用', label: '关于', icon: Info },
] as const;

export type SettingsTab = typeof settingsPages[number]['id'];

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
  return <img className={`brand-mark ${className}`} src={appIcon} alt="" draggable={false} />;
}
