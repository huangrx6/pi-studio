import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PanelRightOpen } from 'lucide-react';
import { Markdown } from '../../shared/Markdown';
import type { ChatMessage } from '../../types/chat-types';
import { textBlocks } from './message-content';
import type { ActivityEntry } from './turn-content';
import { isNearBottom, resolveLiveFollow } from './chat-scroll';
import {
  ACTIVITY_OUTPUT_EXPAND_STEP,
  ACTIVITY_OUTPUT_SOFT_LIMIT,
  clampActivityText,
} from './activity-window';

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
    {entry.block.redacted
      ? <p>模型未提供思考正文。</p>
      : <Markdown streaming={entry.live}>{entry.block.thinking}</Markdown>}
  </div>;
}

function ExpandableCodeComponent({ text, error = false }: { text: string; error?: boolean }) {
  const [limit, setLimit] = useState(ACTIVITY_OUTPUT_SOFT_LIMIT);
  const clamped = clampActivityText(text, limit);
  const fullyShown = !clamped.truncated;
  const remaining = clamped.omitted;
  const nextChunk = Math.min(ACTIVITY_OUTPUT_EXPAND_STEP, remaining);
  return <>
    <pre className={'activity-tool-code' + (error ? ' is-error' : '') + (text.length > ACTIVITY_OUTPUT_SOFT_LIMIT ? ' is-long' : '')}>{clamped.text}</pre>
    {!fullyShown && (
      <div className="activity-output-actions">
        <button
          type="button"
          className="activity-earlier"
          onClick={() => setLimit((current) => Math.min(text.length, current + ACTIVITY_OUTPUT_EXPAND_STEP))}
        >再显示约 {Math.max(1, Math.ceil(nextChunk / 1000))}k 字符</button>
        {remaining > ACTIVITY_OUTPUT_EXPAND_STEP && (
          <button
            type="button"
            className="activity-earlier"
            onClick={() => setLimit(text.length)}
          >全部展开（约 {Math.ceil(remaining / 1000)}k）</button>
        )}
      </div>
    )}
    {fullyShown && text.length > ACTIVITY_OUTPUT_SOFT_LIMIT && (
      <button type="button" className="activity-earlier" onClick={() => setLimit(ACTIVITY_OUTPUT_SOFT_LIMIT)}>
        收起输出
      </button>
    )}
  </>;
}

const ExpandableCode = memo(ExpandableCodeComponent);

function ToolDetails({ entry, result, onOpenFile }: {
  entry: Extract<ActivityEntry, { kind: 'tool' }>;
  result?: ChatMessage;
  onOpenFile?: (path: string) => void;
}) {
  const { call } = entry;
  const args = call.arguments || {};
  const command = ['bash', 'powershell'].includes(call.name) && typeof args.command === 'string' ? args.command : undefined;
  const parameterText = useMemo(() => {
    const source = command === undefined
      ? args
      : Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'command'));
    return Object.keys(source).length > 0 ? JSON.stringify(source, null, 2) : '';
  }, [args, command]);
  const output = result && textBlocks(result.content);
  const file = ['read', 'write', 'edit'].includes(call.name) ? args.path ?? args.file_path : null;
  const resultView = output && <>
    <div className="activity-tool-label">{result?.isError ? '错误信息' : '结果'}</div>
    <ExpandableCode text={output} error={Boolean(result?.isError)} />
  </>;
  return <div className="activity-tool-body activity-disclosure-body">
    {result?.isError && resultView}
    {typeof file === 'string' && onOpenFile && <button type="button" className="activity-open-file" onClick={() => onOpenFile(file)}>
      <PanelRightOpen />打开文件</button>}
    {command !== undefined && <><div className="activity-tool-label">命令</div><ExpandableCode text={command} /></>}
    {parameterText && <><div className="activity-tool-label">参数</div>
      <ExpandableCode text={parameterText} /></>}
    {!result?.isError && resultView}
    {!command && !parameterText && !output && <span className="activity-tool-label">{result ? '工具未返回文本。' : entry.live ? '等待工具返回结果…' : '没有收到工具结果。'}</span>}
  </div>;
}

/** Called only for an open row. In particular, never stringify a closed tool's payload. */
export function ActivityDetails({ entry, result, onOpenFile }: {
  entry: ActivityEntry; result?: ChatMessage; onOpenFile?: (path: string) => void;
}) {
  if (entry.kind === 'thinking') return <ThinkingBody entry={entry} />;
  return <ToolDetails entry={entry} result={result} onOpenFile={onOpenFile} />;
}
