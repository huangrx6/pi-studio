import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, CircleAlert, CircleX, Image as ImageIcon } from 'lucide-react';
import type { StepCollapse, StepDisplay } from '../../shared/preferences';
import { LoadingIndicator } from '../../shared/LoadingState';
import type { ChatMessage } from '../../types/chat-types';
import { ActivityDetails } from './ActivityDetails';
import { ActivitySummary } from './ActivitySummary';
import { ConversationImageGallery, type ConversationImage } from './ConversationImageGallery';
import type { ActivityEntry } from './turn-content';

type ActivityProps = {
  entries: ActivityEntry[];
  results: Map<string, ChatMessage>;
  live: boolean;
  active: boolean;
  policy: StepCollapse;
  density: StepDisplay;
  onOpenFile?: (path: string) => void;
};

// A reader's choice survives incoming tokens. An auto-collapse preference takes effect
// at the end of a turn, while a manual preference survives that boundary too.
function useDisclosure(initial: boolean, boundary: string) {
  const [choice, setChoice] = useState<{ boundary: string; open: boolean }>();
  const open = choice?.boundary === boundary ? choice.open : initial;
  return [open, () => setChoice({ boundary, open: !open })] as const;
}

function ActivityStatus({ failed, incomplete, running, grouped = false }: { failed: number; incomplete: number; running: boolean; grouped?: boolean }) {
  return <span className="activity-status">
    {failed > 0 && <span className="activity-tool-status is-error"><CircleX />{grouped ? failed + ' 步失败' : '失败'}</span>}
    {incomplete > 0 && <span className="activity-tool-status"><CircleAlert />{grouped ? incomplete + ' 步未完成' : '未完成'}</span>}
    {running && <span className="activity-tool-status is-running"><LoadingIndicator />执行中</span>}
  </span>;
}

function ActivityRow({ entry, results, defaultOpen, boundary, onOpenFile, onInspect }: {
  entry: ActivityEntry; results: Map<string, ChatMessage>; defaultOpen: boolean; boundary: string;
  onOpenFile?: (path: string) => void;
  onInspect?: (key: string) => void;
}) {
  const [open, toggle] = useDisclosure(defaultOpen, boundary);
  const id = useId();
  const result = entry.kind === 'tool' ? results.get(entry.call.id) : undefined;
  const failed = Boolean(result?.isError);
  const incomplete = entry.kind === 'tool' && !entry.live && !result;
  const state = failed ? 'is-error' : incomplete ? 'is-incomplete' : entry.live ? 'is-live is-running' : 'is-done';
  return <details open={open} className={'activity-disclosure activity-' + entry.kind + ' ' + state}>
    <summary className="activity-disclosure-summary" aria-expanded={open} aria-controls={id}
      aria-description={result && !failed ? '已完成' : undefined}
      onClick={event => { event.preventDefault(); onInspect?.(entry.key); toggle(); }}>
      <ActivitySummary entries={[entry]} results={results} expanded={open} onOpenFile={onOpenFile} />
      <ActivityStatus failed={Number(failed)} incomplete={Number(incomplete)} running={entry.live && entry.kind === 'tool'} />
      <ChevronDown className="activity-disclosure-chevron" aria-hidden="true" />
    </summary>
    <div id={id}>{open && <ActivityDetails entry={entry} result={result} onOpenFile={onOpenFile} />}</div>
  </details>;
}

export function TurnActivity({ entries, results, live, active, policy, density, onOpenFile }: ActivityProps) {
  const boundary = [density, policy, policy === 'after-answer' && live].join('/');
  const showDuringTurn = policy !== 'after-answer' || (live && active);
  const [open, toggle] = useDisclosure(showDuringTurn && (density !== 'compact' || policy === 'keep-open'), boundary);
  const [expandedHistory, setExpandedHistory] = useState(false);
  const [inspected, setInspected] = useState<ReadonlySet<string>>(() => new Set());
  const [visited, setVisited] = useState(open);
  useEffect(() => { if (open) setVisited(true); }, [open]);
  const id = useId();
  const heading = useRef<HTMLButtonElement>(null);
  const grouped = entries.length > 1;
  const failed = entries.filter(e => e.kind === 'tool' && results.get(e.call.id)?.isError).length;
  const incomplete = entries.filter(e => e.kind === 'tool' && !e.live && !results.has(e.call.id)).length;
  const running = entries.some(e => e.live);
  // In a long live sequence keep unfinished work visible even when results arrive out of order.
  const limitHistory = live && active && density !== 'detailed' && !expandedHistory && entries.length > 5;
  const visible = limitHistory
    ? entries.filter((entry, index) => entry.live || inspected.has(entry.key) || index >= entries.length - 3 || (entry.kind === 'tool' && results.get(entry.call.id)?.isError)) : entries;
  const hidden = entries.length - visible.length;
  return <section className={'turn-trace' + (grouped ? ' is-grouped' : ' is-single')} aria-label="执行记录">
    {grouped && <button type="button" ref={heading} className="turn-trace-toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
      <ActivitySummary entries={entries} results={results} />
      {!open && <ActivityStatus failed={failed} incomplete={incomplete} running={running} grouped />}
      <ChevronDown className="activity-disclosure-chevron" aria-hidden="true" />
    </button>}
    <div className="activity-sequence" id={id} hidden={grouped && !open}>
      {(!grouped || open || visited) && <>
        {hidden > 0 && <button type="button" className="activity-earlier" onClick={() => setExpandedHistory(true)}>查看此前 {hidden} 个步骤</button>}
        {visible.map(entry => <ActivityRow key={entry.key} entry={entry} results={results} boundary={boundary} onOpenFile={onOpenFile}
          onInspect={live ? key => setInspected(previous => previous.has(key) ? previous : new Set(previous).add(key)) : undefined}
          defaultOpen={showDuringTurn && (density === 'detailed' || (density !== 'compact' && entry.kind === 'thinking' && entry.live))} />)}
        {visible.length > 5 && open && <button type="button" className="activity-earlier turn-trace-collapse"
          onClick={() => { toggle(); heading.current?.focus(); }}>收起执行过程</button>}
      </>}
    </div>
  </section>;
}

export function ToolResultImages({ callId, images }: { callId: string; images: ConversationImage[] }) {
  const [open, setOpen] = useState(true);
  const id = useId();
  return <div className="tool-result-images" data-tool-call-id={callId}>
    <button type="button" className="tool-result-images-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <ImageIcon /><span>图像结果</span><span>{images.length}</span><ChevronDown className="activity-disclosure-chevron" />
    </button>
    <div id={id} hidden={!open}><ConversationImageGallery images={images} /></div>
  </div>;
}
