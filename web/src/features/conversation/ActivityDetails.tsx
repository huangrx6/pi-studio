import { useLayoutEffect, useRef } from 'react';
import { PanelRightOpen } from 'lucide-react';
import { Markdown } from '../../shared/Markdown';
import type { ChatMessage } from '../../types/chat-types';
import { textBlocks } from './message-content';
import type { ActivityEntry } from './turn-content';
import { isNearBottom, resolveLiveFollow } from './chat-scroll';

function ThinkingBody({ entry }: { entry: Extract<ActivityEntry, { kind: 'thinking' }> }) {
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (entry.live && body.current && following.current) body.current.scrollTop = body.current.scrollHeight;
  }, [entry.live, entry.block.thinking]);
  return <div ref={body} className="activity-thinking-body activity-disclosure-body"
    onWheel={event => { if (event.deltaY < 0) following.current = resolveLiveFollow({ wheelUp: true }); }}
    onTouchMove={() => { following.current = false; }}
    onScroll={event => { following.current = resolveLiveFollow({ nearBottom: isNearBottom(event.currentTarget) }); }}>
    {entry.block.redacted ? <p>模型未提供思考正文。</p> : <Markdown>{entry.block.thinking}</Markdown>}
  </div>;
}

/** Called only for an open row. In particular, never stringify a closed tool's payload. */
export function ActivityDetails({ entry, result, onOpenFile }: {
  entry: ActivityEntry; result?: ChatMessage; onOpenFile?: (path: string) => void;
}) {
  if (entry.kind === 'thinking') return <ThinkingBody entry={entry} />;
  const { call } = entry;
  const args = call.arguments || {};
  const command = ['bash', 'powershell'].includes(call.name) && typeof args.command === 'string' ? args.command : undefined;
  const parameters = command === undefined ? args : Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'command'));
  const output = result && textBlocks(result.content);
  const file = ['read', 'write', 'edit'].includes(call.name) ? args.path ?? args.file_path : null;
  const resultView = output && <><div className="activity-tool-label">{result?.isError ? '错误信息' : '结果'}</div>
    <pre className={'activity-tool-code' + (result?.isError ? ' is-error' : '')}>{output}</pre></>;
  return <div className="activity-tool-body activity-disclosure-body">
    {result?.isError && resultView}
    {typeof file === 'string' && onOpenFile && <button type="button" className="activity-open-file" onClick={() => onOpenFile(file)}>
      <PanelRightOpen />打开文件</button>}
    {command !== undefined && <><div className="activity-tool-label">命令</div><pre className="activity-tool-code">{command}</pre></>}
    {Object.keys(parameters).length > 0 && <><div className="activity-tool-label">参数</div>
      <pre className="activity-tool-code">{JSON.stringify(parameters, null, 2)}</pre></>}
    {!result?.isError && resultView}
    {!command && !Object.keys(parameters).length && !output && <span className="activity-tool-label">{result ? '工具未返回文本。' : entry.live ? '等待工具返回结果…' : '没有收到工具结果。'}</span>}
  </div>;
}
