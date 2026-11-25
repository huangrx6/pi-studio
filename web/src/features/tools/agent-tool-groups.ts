import type { AgentToolCatalog, AgentToolCommand, AgentToolInfo, AgentToolSource } from '../../types/agent-tool-types';
import builtinDescriptions from '../../../../assets/settings/builtin-tool-descriptions.zh-CN.json' with { type: 'json' };

const BUILTIN_GROUPS = [
  { label: '文件与终端', defaultOpen: true, sources: ['builtin:durable-coding-tools', 'durable:coding', 'builtin:studio-filesystem-tools'] },
  { label: '浏览器', sources: ['builtin:studio-browser-tools'] },
  { label: '电脑操控', sources: ['builtin:studio-desktop-control'] },
  { label: '任务与协作', sources: ['builtin:studio-todo', 'builtin:studio-long-task', 'builtin:studio-subagents', 'builtin:studio-subagent-channel'] },
  { label: '工具与技能发现', sources: ['builtin:studio-tool-search', 'builtin:studio-skills'] },
];
const builtinToolDescriptions = new Map(Object.entries(builtinDescriptions));

type CatalogText = { description: string; originalDescription?: string };
export type CatalogDisplayEntry<T> = T & CatalogText;
type Group = {
  key: string; label: string; order: number; defaultOpen: boolean;
  tools: CatalogDisplayEntry<AgentToolInfo>[];
  commands: CatalogDisplayEntry<AgentToolCommand>[];
};

function catalogText(description: string, builtinText?: string): CatalogText {
  if (builtinText) return { description: builtinText };
  const original = description?.trim();
  if (!original) return { description: '暂无说明。' };
  if (/\p{Script=Han}/u.test(original)) return { description: original };
  return { description: '作者尚未提供中文说明。', originalDescription: original };
}

export function isMcpMethod(tool: AgentToolInfo) {
  return tool.source.kind === 'mcp' || tool.name.startsWith('mcp__');
}

export function groupAgentTools(catalog: AgentToolCatalog, query: string): Group[] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, Group>();
  function groupFor(source: AgentToolSource, name: string, description: string, original: string) {
    const index = source.kind === 'core' ? BUILTIN_GROUPS.findIndex(group => group.sources.includes(source.key)) : -1;
    const category = BUILTIN_GROUPS[index];
    const label = category?.label ?? source.label;
    if (needle && ![label, source.label, source.source, name, description, original].join(' ').toLowerCase().includes(needle)) return;
    const key = category ? `builtin-group:${index}` : JSON.stringify([source.kind, source.scope, source.source || source.key]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key, label, order: index >= 0 ? index : source.kind === 'core' ? BUILTIN_GROUPS.length : BUILTIN_GROUPS.length + 1,
        defaultOpen: Boolean(category?.defaultOpen), tools: [], commands: [],
      };
      groups.set(key, group);
    }
    return group;
  }
  for (const tool of catalog.tools) {
    if (isMcpMethod(tool)) continue;
    const builtinText = tool.source.kind === 'core' ? builtinToolDescriptions.get(tool.name) : undefined;
    const entry = { ...tool, ...catalogText(tool.description, builtinText) };
    groupFor(tool.source, tool.name, entry.description, tool.description)?.tools.push(entry);
  }
  for (const command of catalog.commands) {
    const entry = { ...command, ...catalogText(command.description) };
    groupFor(command.source, `/${command.name}`, entry.description, command.description)?.commands.push(entry);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}
