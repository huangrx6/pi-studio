import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { StepCollapse, StepDisplay } from '../../shared/preferences';
import type { ChatMessage } from '../../types/chat-types';
import { ActivityDetails } from './ActivityDetails';
import { ConversationImageGallery } from './ConversationImageGallery';
import { activityKind, type ActivityEntry } from './turn-content';
import { progressEntryLabel, type buildTurnProgress } from './turn-progress';
import './styles/turn-progress.css';

type Progress = ReturnType<typeof buildTurnProgress>;
type RecordMode = 'all' | 'failures' | 'closed';

function firstErrorLine(result?: ChatMessage) {
  const block = result?.content.find(item => item.type === 'text' && item.text.trim());
  const text = result?.errorMessage || (block?.type === 'text' ? block.text : '');
  return text.trimStart().slice(0, 240).split('\n', 1)[0];
}

function ProgressRecords({ progress, results, mode, density, onOpenFile }: {
  progress: Progress;
  results: Map<string, ChatMessage>;
  mode: Exclude<RecordMode, 'closed'>;
  density: StepDisplay;
  onOpenFile?: (path: string) => void;
}) {
  const [pageEnd, setPageEnd] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null | undefined>();
  const listId = useId();
  const records = mode === 'failures'
    ? progress.entries.filter(entry => entry.kind === 'tool' && results.get(entry.call.id)?.isError)
    : progress.entries;
  const pageSize = density === 'compact' ? 6 : 12;
  const end = Math.min(pageEnd ?? records.length, records.length);
  const start = Math.max(0, end - pageSize);
  const selectedKey = selected === undefined && density === 'detailed' ? records[end - 1]?.key : selected;

  function toggleRecord(entry: ActivityEntry) {
    const next = selectedKey === entry.key ? null : entry.key;
    setSelected(next);
    // Keep the inspected row on the page when more calls arrive.
    if (next) setPageEnd(end);
  }

  return <div className="turn-progress-history">
    {start > 0 && <button type="button" className="turn-progress-page" onClick={() => setPageEnd(start)}>查看较早的记录</button>}
    <ol className="turn-progress-list" start={start + 1} aria-label={mode === 'failures' ? '失败的工具调用' : '执行明细'}>
      {records.slice(start, end).map(entry => {
        const result = entry.kind === 'tool' ? results.get(entry.call.id) : undefined;
        const images = entry.kind === 'tool' && activityKind(entry) !== 'image' ? progress.images.get(entry.call.id) : undefined;
        const expanded = entry.key === selectedKey;
        const errorLine = result?.isError && !expanded ? firstErrorLine(result) : '';
        const bodyId = listId + '-' + entry.key;
        const label = progressEntryLabel(entry);
        const status = result?.isError ? '失败' : entry.live ? '执行中'
          : entry.kind === 'tool' && !result ? '未完成' : '';
        return <li key={entry.key} className="turn-progress-record">
          <button className="turn-progress-record-toggle" type="button" aria-expanded={expanded}
            aria-controls={expanded ? bodyId : undefined} onClick={() => toggleRecord(entry)}>
            <span className="turn-progress-record-label" title={label}>{label}</span>
            {images && images.length > 0 && <span className="turn-progress-meta">{images.length} 张图</span>}
            {status && <span className={'turn-progress-meta' + (result?.isError ? ' is-error' : '')}>{status}</span>}
            <ChevronRight aria-hidden="true" />
          </button>
          {errorLine && <p className="turn-progress-error-preview">{errorLine}</p>}
          {expanded && <div id={bodyId} className="turn-progress-record-body">
            <ActivityDetails entry={entry} result={result} onOpenFile={onOpenFile} />
            {images && images.length > 0 && <ConversationImageGallery className="is-inline-step" images={images} />}
          </div>}
        </li>;
      })}
    </ol>
    {end < records.length && <button type="button" className="turn-progress-page" onClick={() => {
      const next = end + pageSize;
      setPageEnd(next >= records.length ? null : next);
    }}>查看较新的记录</button>}
  </div>;
}

export function TurnProgress({ progress, results, live, policy, density, onOpenFile }: {
  progress: Progress;
  results: Map<string, ChatMessage>;
  live: boolean;
  policy: StepCollapse;
  density: StepDisplay;
  onOpenFile?: (path: string) => void;
}) {
  const listId = useId();
  const [choice, setChoice] = useState<{ boundary: string; mode: RecordMode }>();
  const boundary = [policy, density, policy === 'after-answer' && live].join('/');
  const defaultOpen = policy === 'keep-open' || (density === 'detailed' && policy === 'after-answer' && live);
  const mode = choice?.boundary === boundary ? choice.mode : defaultOpen ? 'all' : 'closed';
  const open = mode !== 'closed';
  const hasRecords = progress.entries.some(entry => entry.kind === 'tool') || (
    progress.entries.length > 0 && (live || density === 'detailed' || policy === 'keep-open')
  );
  if (!hasRecords && !progress.action) return null;
  const label = progress.action || (open ? '收起执行记录' : '查看执行记录');
  const action = <span className="turn-progress-action" aria-live={live && hasRecords ? 'polite' : undefined}>{label}</span>;
  return <section className="turn-progress" aria-label="本轮执行进展">
    <div className="turn-progress-line">
      {hasRecords
        ? <button type="button" className="turn-progress-toggle" aria-expanded={open}
            aria-controls={open ? listId : undefined} title={label}
            onClick={() => setChoice({ boundary, mode: open ? 'closed' : 'all' })}>
            {progress.action && <span className="turn-progress-dot" aria-hidden="true" />}
            {action}<ChevronRight aria-hidden="true" />
          </button>
        : <span className="turn-progress-status" role="status"><span className="turn-progress-dot" aria-hidden="true" />{action}</span>}
      {progress.failed > 0 && <button type="button" className="turn-progress-failures" aria-pressed={mode === 'failures'}
        onClick={() => setChoice({ boundary, mode: mode === 'failures' ? 'all' : 'failures' })}>
        {progress.failed} 次调用失败
      </button>}
    </div>
    {open && hasRecords && <div id={listId}>
      <ProgressRecords key={mode} mode={mode} progress={progress} results={results} density={density} onOpenFile={onOpenFile} />
    </div>}
  </section>;
}
