import { memo, type ReactNode } from 'react';
import { Bot, FileText, Globe, Image as ImageIcon, ListTree, Pencil, Search, Sparkles, Terminal, Wrench } from 'lucide-react';
import type { ChatMessage, ToolCallBlock } from '../../types/chat-types';
import { FileKindIcon } from '../../shared/FileKindIcon';
import { toolResultDiff, writtenLineCount } from './file-changes';
import { activityKind, type ActivityEntry } from './turn-content';

const basename = (path: string) => path.split(/[\\/]/).pop() || path;
function filePath(call: ToolCallBlock) {
  const path = call.arguments?.path ?? call.arguments?.file_path;
  return typeof path === 'string' ? path : '';
}

function FileTarget({ path, children, onOpenFile }: { path: string; children: ReactNode; onOpenFile?: (path: string) => void }) {
  return onOpenFile ? <button type="button" className="activity-file-target" title={path}
    onClick={event => { event.preventDefault(); event.stopPropagation(); onOpenFile(path); }}>{children}</button> : <span>{children}</span>;
}

function MutationSummary({ calls, results, onOpenFile }: { calls: ToolCallBlock[]; results: Map<string, ChatMessage>; onOpenFile?: (path: string) => void }) {
  const paths = [...new Set(calls.map(filePath).filter(Boolean))];
  let added = 0, removed = 0, lines = 0, withDelta = 0, wholeWrites = 0, successful = 0;
  for (const call of calls) {
    const result = results.get(call.id);
    if (!result || result.isError) continue;
    successful++;
    const delta = toolResultDiff(result);
    if (delta) {
      added += delta.added;
      removed += delta.removed;
      withDelta++;
    } else if (call.name === 'write' && typeof call.arguments?.content === 'string') {
      lines += writtenLineCount(call.arguments.content);
      wholeWrites++;
    }
  }
  const shown = paths.slice(0, 3);
  return <>
    {shown.map((path, index) => <span className="inline-activity-file" key={path} title={path}>
      <FileKindIcon path={path} /><FileTarget path={path} onOpenFile={onOpenFile}>{paths.some(other => other !== path && basename(other) === basename(path)) ? path : basename(path)}</FileTarget>
      {index < shown.length - 1 && <i aria-hidden="true">,</i>}
    </span>)}
    {paths.length > shown.length && <span>另 {paths.length - shown.length} 个文件</span>}
    {withDelta > 0 && withDelta === successful && <span className="inline-activity-delta">
      {added > 0 && <span className="added">+{added}</span>}{removed > 0 && <span className="removed">−{removed}</span>}
    </span>}
    {wholeWrites > 0 && wholeWrites === successful && <span title="写入内容的行数">{lines} 行</span>}
  </>;
}

function label(icon: ReactNode, name: string, preview?: ReactNode, mono = false, title?: string) {
  return <span className="activity-summary">
    <span className="activity-disclosure-icon" aria-hidden="true">{icon}</span>
    <strong className="activity-disclosure-title" title={title}>{name}</strong>
    {preview && <span className={'activity-disclosure-preview' + (mono ? ' is-mono' : '')}>{preview}</span>}
  </span>;
}

function short(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 200).replace(/\s+/g, ' ') : '';
}

const agentActions: Record<string, string> = {
  spawn: '启动子智能体', run: '运行子智能体', send: '继续子智能体', status: '查询子智能体',
  stop: '停止子智能体', wait: '等待子智能体', pending: '查看待答问题', reply: '回复子智能体',
};

function ActivitySummaryComponent({ entries, results, expanded = false, onOpenFile }: {
  entries: ActivityEntry[]; results: Map<string, ChatMessage>; expanded?: boolean; onOpenFile?: (path: string) => void;
}) {
  const first = entries[0];
  const kind = activityKind(first);
  const calls = entries.flatMap(entry => entry.kind === 'tool' ? [entry.call] : []);
  if (entries.some(entry => activityKind(entry) !== kind)) {
    const thoughts = entries.length - calls.length;
    return label(<ListTree />, '执行过程', [calls.length && calls.length + ' 次工具调用', thoughts && thoughts + ' 次思考'].filter(Boolean).join(' · '));
  }
  if (first.kind === 'thinking') {
    const preview = first.block.redacted ? '模型未提供内容' : short(first.block.thinking);
    return label(<Sparkles />, first.live ? '思考中' : '思考', entries.length > 1 ? entries.length + ' 个步骤' : !expanded && preview);
  }
  const call = first.call, args = call.arguments || {};
  if (kind === 'write' || kind === 'edit') {
    return label(<Pencil />, kind === 'write' ? '写入' : '更新', <MutationSummary calls={calls} results={results} onOpenFile={onOpenFile} />);
  }
  if (entries.length > 1) {
    if (kind === 'explore') {
      const searches = calls.filter(c => c.name === 'find' || c.name === 'grep').length;
      const files = new Set(calls.filter(c => c.name === 'read').map(filePath).filter(Boolean)).size;
      const dirs = calls.filter(c => c.name === 'ls').length;
      return label(<Search />, '探索', [searches && searches + ' 次搜索', files && files + ' 个文件', dirs && dirs + ' 次目录浏览'].filter(Boolean).join('，'));
    }
    if (kind === 'command') return label(<Terminal />, '运行命令', calls.length + ' 条');
    if (kind === 'search' || kind === 'fetch') return label(<Globe />, kind === 'fetch' ? '读取网页' : '搜索网页', calls.length + ' 次');
    return label(<ListTree />, '执行过程', calls.length + ' 次工具调用');
  }
  if (kind === 'command') return label(<Terminal />, '运行命令', !expanded && short(args.command), true, call.name);
  if (kind === 'search' || kind === 'fetch') return label(<Globe />, kind === 'fetch' ? '读取网页' : '搜索网页', short(args.query || args.url));
  if (kind === 'agent') {
    const action = call.name === 'bg_wait' ? 'wait' : call.name === 'subagent_stop' ? 'stop' : String(args.action || 'run');
    return label(<Bot />, agentActions[action] || '子智能体', short(args.name || args.agent || args.task || args.action), false, call.name);
  }
  if (kind === 'image') return label(<ImageIcon />, '生成图片');
  if (kind === 'explore') {
    const name = { read: '读取文件', grep: '搜索内容', find: '查找文件', ls: '浏览目录' }[call.name];
    const path = filePath(call);
    const target = call.name === 'read' && path ? <FileTarget path={path} onOpenFile={onOpenFile}>{path}</FileTarget> : short(args.pattern || path);
    return label(call.name === 'read' ? <FileText /> : <Search />, name || '探索', target, true);
  }
  return label(<Wrench />, call.name.split('__').at(-1) || call.name, short(args.name || args.description || args.path), false, call.name);
}

export const ActivitySummary = memo(ActivitySummaryComponent);
