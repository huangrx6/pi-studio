import { Globe, Image as ImageIcon, Pencil, Search, Sparkles, Terminal, Wrench } from 'lucide-react';
import type { ChatMessage, ContentBlock, ToolCallBlock } from '../../types/chat-types';
import { FileKindIcon } from '../../shared/FileKindIcon';
import { toolResultDiff, writtenLineCount } from './file-changes';
import { webAction } from './web-sources';

export type ActivityEntry = (
  | { kind: 'tool'; call: ToolCallBlock }
  | { kind: 'thinking'; block: Extract<ContentBlock, { type: 'thinking' }> }
) & { key: string; live?: boolean };

export function activityKind(entry: ActivityEntry) {
  if (entry.kind === 'thinking') return 'thinking';
  const web = webAction(entry.call);
  if (web) return web;
  if (/^(?:generate_image|image_generation|imagegen|text_to_image)$/.test(entry.call.name.split('__').at(-1) || '')) return 'image';
  switch (entry.call.name) {
    case 'read': case 'grep': case 'find': case 'ls': return 'explore';
    case 'write': return 'write';
    case 'edit': return 'edit';
    case 'bash': case 'powershell': return 'command';
    default: return 'other';
  }
}

const basename = (path: string) => path.split(/[\\/]/).pop() || path;
function filePath(call: ToolCallBlock) {
  const path = call.arguments?.path ?? call.arguments?.file_path;
  return typeof path === 'string' ? path : '';
}

function MutationSummary({ calls, results }: { calls: ToolCallBlock[]; results: Map<string, ChatMessage> }) {
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
      <FileKindIcon path={path} /><span>{paths.some(other => other !== path && basename(other) === basename(path)) ? path : basename(path)}</span>
      {index < shown.length - 1 && <i aria-hidden="true">,</i>}
    </span>)}
    {paths.length > shown.length && <span>另 {paths.length - shown.length} 个文件</span>}
    {withDelta > 0 && withDelta === successful && <span className="inline-activity-delta">
      {added > 0 && <span className="added">+{added}</span>}{removed > 0 && <span className="removed">−{removed}</span>}
    </span>}
    {wholeWrites > 0 && wholeWrites === successful && <span title="写入内容的行数">{lines} 行</span>}
  </>;
}

export function ActivitySummary({ entries, results }: { entries: ActivityEntry[]; results: Map<string, ChatMessage> }) {
  const first = entries[0];
  if (first.kind === 'thinking') return <><Sparkles /><strong>思考</strong></>;
  const kind = activityKind(first);
  const calls = entries.flatMap(entry => entry.kind === 'tool' ? [entry.call] : []);
  if (kind === 'image') return <><ImageIcon /><strong>生成图片</strong></>;
  if (kind === 'search' || kind === 'fetch') return <><Globe /><strong>{kind === 'search' ? '搜索网页' : '读取网页'}</strong></>;
  if (kind === 'explore') {
    const searches = calls.filter(call => call.name === 'find' || call.name === 'grep').length;
    const files = new Set(calls.filter(call => call.name === 'read').map(filePath).filter(Boolean)).size;
    const directories = calls.filter(call => call.name === 'ls').length;
    return <><Search /><strong>探索</strong><span>{[
      searches && `${searches} 次搜索`, files && `${files} 个文件`, directories && `${directories} 次目录浏览`,
    ].filter(Boolean).join('，')}</span></>;
  }
  if (kind === 'write' || kind === 'edit') return <>
    <Pencil /><strong>{kind === 'write' ? '写入' : '更新'}</strong><MutationSummary calls={calls} results={results} />
  </>;
  if (kind === 'command') {
    const command = first.call.arguments?.command;
    const preview = typeof command === 'string' ? command.trim().replace(/\s+/g, ' ') : '';
    return <><Terminal /><strong>运行</strong>{preview && <code>{preview.length > 160 ? preview.slice(0, 159) + '…' : preview}</code>}</>;
  }
  return <><Wrench /><strong>{first.call.name}</strong></>;
}
