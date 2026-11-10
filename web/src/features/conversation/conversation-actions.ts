import type { ComposerCommand } from '../../types/chat-types';

/** JSON-safe action descriptions. Only the host dispatches executable handlers. */
export type ConversationAction = {
  id: string;
  title: string;
  description: string;
  group: 'conversation' | 'workspace' | 'extension';
  keywords: string[];
  disabledReason?: string;
  command?: { id: string; name: string; argumentHint?: string };
};

export type ConversationActionContext = {
  sessionId?: string;
  workspace: string;
  running: boolean;
  loading: boolean;
  hasMessages: boolean;
  hasChildren: boolean;
  hasExtensions: boolean;
};

export function conversationActions(ctx: ConversationActionContext, commands: ComposerCommand[] = []): ConversationAction[] {
  const sessionReason = ctx.loading ? '正在读取会话' : !ctx.sessionId ? '请先开始一个会话' : undefined;
  const actions: ConversationAction[] = [
    { id: 'fork', title: '分叉当前会话', description: '从当前进度建立独立会话', group: 'conversation', keywords: ['fork', 'branch', '分支'], disabledReason: sessionReason || (!ctx.hasMessages ? '会话还没有消息' : ctx.running ? '请等待任务结束或先停止任务' : undefined) },
    { id: 'compare', title: '模型同题双跑', description: '在右侧工作台独立评估两个模型', group: 'workspace', keywords: ['compare', '模型', '对比', '双跑'], disabledReason: !ctx.workspace ? '请先选择工作区' : undefined },
    { id: 'goal', title: '设置目标', description: '在输入框中填写持续执行的目标', group: 'conversation', keywords: ['goal', '任务', '长期'], disabledReason: ctx.loading ? '正在读取会话' : !ctx.workspace ? '请先选择工作区' : undefined },
    { id: 'subagents', title: '查看子智能体', description: '运行状态、上下文和执行结果', group: 'conversation', keywords: ['agent', '并行'], disabledReason: sessionReason || (!ctx.hasChildren ? '当前会话还没有子智能体' : undefined) },
    { id: 'extensions', title: '查看会话扩展', description: '当前会话的扩展内容与布局', group: 'conversation', keywords: ['extension', '指标', '额度'], disabledReason: sessionReason || (!ctx.hasExtensions ? '没有可展示的会话扩展' : undefined) },
    { id: 'temporary', title: '临时聊天', description: '在右侧打开独立的临时聊天', group: 'workspace', keywords: ['temporary', 'chat'] },
    { id: 'files', title: '浏览工作区文件', description: '在右侧打开文件面板', group: 'workspace', keywords: ['file', '目录'], disabledReason: !ctx.workspace ? '请先选择工作区' : undefined },
    { id: 'models', title: '模型配置', description: '管理模型来源与可用模型', group: 'workspace', keywords: ['model', 'provider'] },
    { id: 'mcp', title: 'MCP 服务器', description: '管理连接、工具与认证', group: 'workspace', keywords: ['工具', 'oauth', '服务器'] },
  ];
  const seen = new Set<string>();
  for (const command of commands) {
    if (command.source !== 'extension' || !command.commandId || seen.has(command.commandId)) continue;
    seen.add(command.commandId);
    actions.push({
      id: `extension:${command.commandId}`, title: command.name, description: command.description,
      group: 'extension', keywords: [command.name, '扩展'],
      command: { id: command.commandId, name: command.name, argumentHint: command.argumentHint },
      disabledReason: ctx.loading ? '正在读取会话' : undefined,
    });
  }
  return actions;
}

export function filterConversationActions(actions: ConversationAction[], query: string): ConversationAction[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return actions.filter(action => {
    const haystack = [action.title, action.description, ...action.keywords].join(' ').toLocaleLowerCase();
    return words.every(word => haystack.includes(word));
  });
}
