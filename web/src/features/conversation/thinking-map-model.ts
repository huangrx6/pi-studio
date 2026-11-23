import type { ChatMessage, ToolCallBlock } from '../../types/chat-types.ts';
import { activityKind, type ActivityEntry } from './turn-content.ts';

export type ThinkingMapNodeKind =
  | 'thinking'
  | 'explore'
  | 'write'
  | 'edit'
  | 'command'
  | 'search'
  | 'fetch'
  | 'browser'
  | 'agent'
  | 'image'
  | 'other';

export type ThinkingMapNodeStatus = 'running' | 'done' | 'error' | 'incomplete' | 'pending';

export type ThinkingMapNode = {
  id: string;
  kind: ThinkingMapNodeKind;
  title: string;
  preview: string;
  detail: string;
  status: ThinkingMapNodeStatus;
  toolName?: string;
  live: boolean;
};

export type ThinkingMapModel = {
  nodes: ThinkingMapNode[];
  stats: {
    total: number;
    thinking: number;
    tools: number;
    errors: number;
    running: number;
  };
};

function short(value: unknown, limit = 160): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, limit);
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function filePath(call: ToolCallBlock): string {
  const path = call.arguments?.path ?? call.arguments?.file_path;
  return typeof path === 'string' ? path : '';
}

function toolTitle(call: ToolCallBlock, kind: ThinkingMapNodeKind): string {
  const browserNames: Record<string, string> = {
    browser_tabs: '浏览器标签',
    browser_open: '打开网页',
    browser_navigate: '浏览导航',
    browser_snapshot: '页面快照',
    browser_screenshot: '页面截图',
    browser_click: '点击页面',
    browser_type: '输入文本',
    browser_scroll: '滚动页面',
    browser_wait: '等待页面',
    browser_select: '选择选项',
    browser_dialog: '处理对话框',
    browser_download: '浏览器下载',
    browser_highlight: '标注页面',
    browser_evaluate: '页面脚本',
  };
  if (kind === 'browser') return browserNames[call.name] || '浏览器';
  if (kind === 'command') return '运行命令';
  if (kind === 'write') return '写入文件';
  if (kind === 'edit') return '更新文件';
  if (kind === 'search') return '搜索网页';
  if (kind === 'fetch') return '读取网页';
  if (kind === 'image') return '生成图片';
  if (kind === 'agent') return '子智能体';
  if (kind === 'explore') {
    return ({ read: '读取文件', grep: '搜索内容', find: '查找文件', ls: '浏览目录' } as Record<string, string>)[call.name] || '探索';
  }
  return call.name.split('__').at(-1) || call.name;
}

function toolPreview(call: ToolCallBlock, kind: ThinkingMapNodeKind): string {
  const args = call.arguments || {};
  if (kind === 'command') return short(args.command, 120);
  if (kind === 'write' || kind === 'edit' || (kind === 'explore' && call.name === 'read')) {
    const path = filePath(call);
    return path ? basename(path) : short(args.pattern || args.query, 120);
  }
  if (kind === 'search' || kind === 'fetch') return short(args.query || args.url, 120);
  if (kind === 'browser') return short(args.url || args.ref || args.text || args.query || args.tabId, 120);
  if (kind === 'agent') return short(args.name || args.agent || args.task || args.action, 120);
  return short(args.name || args.description || args.path || args.pattern || args.query, 120);
}

function toolDetail(call: ToolCallBlock, result?: ChatMessage): string {
  const parts: string[] = [];
  const args = call.arguments || {};
  if (typeof args.command === 'string' && args.command.trim()) {
    parts.push(args.command.trim().slice(0, 4000));
  } else {
    try {
      const json = JSON.stringify(args, null, 2);
      if (json && json !== '{}') parts.push(json.slice(0, 4000));
    } catch {
      // ignore
    }
  }
  if (result) {
    const text = result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text) parts.push((result.isError ? '错误：' : '结果：') + text.slice(0, 4000));
  }
  return parts.join('\n\n').trim();
}

function nodeStatus(entry: ActivityEntry, result?: ChatMessage): ThinkingMapNodeStatus {
  if (entry.kind === 'thinking') return entry.live ? 'running' : 'done';
  if (entry.live) return 'running';
  if (!result) return 'incomplete';
  if (result.isError) return 'error';
  return 'done';
}

export function buildThinkingMap(
  entries: ActivityEntry[],
  results: Map<string, ChatMessage>,
): ThinkingMapModel {
  const nodes: ThinkingMapNode[] = [];
  for (const entry of entries) {
    if (entry.kind === 'thinking') {
      const text = entry.block.redacted ? '' : entry.block.thinking.trim();
      if (!entry.live && !entry.block.redacted && !text) continue;
      nodes.push({
        id: entry.key,
        kind: 'thinking',
        title: entry.live ? '思考中' : '思考',
        preview: entry.block.redacted ? '模型未提供内容' : short(text, 180),
        detail: entry.block.redacted ? '模型未提供思考正文。' : text,
        status: nodeStatus(entry),
        live: entry.live,
      });
      continue;
    }
    const kind = activityKind(entry) as ThinkingMapNodeKind;
    const result = results.get(entry.call.id);
    nodes.push({
      id: entry.key,
      kind: kind === 'thinking' ? 'other' : kind,
      title: toolTitle(entry.call, kind === 'thinking' ? 'other' : kind),
      preview: toolPreview(entry.call, kind === 'thinking' ? 'other' : kind),
      detail: toolDetail(entry.call, result),
      status: nodeStatus(entry, result),
      toolName: entry.call.name,
      live: entry.live,
    });
  }
  return {
    nodes,
    stats: {
      total: nodes.length,
      thinking: nodes.filter((node) => node.kind === 'thinking').length,
      tools: nodes.filter((node) => node.kind !== 'thinking').length,
      errors: nodes.filter((node) => node.status === 'error').length,
      running: nodes.filter((node) => node.status === 'running').length,
    },
  };
}

export function collectActivityEntries(
  segments: Array<{ kind: string; entries?: ActivityEntry[] }>,
): ActivityEntry[] {
  return segments.flatMap((segment) => (segment.kind === 'activity' && segment.entries ? segment.entries : []));
}
