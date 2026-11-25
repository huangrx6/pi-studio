import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, CircleAlert, CircleX, Image as ImageIcon } from 'lucide-react';
import type { StepCollapse, StepDisplay } from '../../shared/preferences';
import { LoadingIndicator } from '../../shared/LoadingState';
import type { ChatMessage } from '../../types/chat-types';
import { ActivityDetails } from './ActivityDetails';
import { ActivitySummary } from './ActivitySummary';
import { ConversationImageGallery, type ConversationImage } from './ConversationImageGallery';
import type { ActivityEntry } from './turn-content';
import { selectVisibleActivityEntries } from './activity-window';

type ActivityProps = {
  entries: ActivityEntry[];
  results: Map<string, ChatMessage>;
  toolImages?: ReadonlyMap<string, ConversationImage[]>;
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

function ActivityRowComponent({ entry, results, images, defaultOpen, boundary, onOpenFile, onInspect }: {
  entry: ActivityEntry; results: Map<string, ChatMessage>; images?: ConversationImage[]; defaultOpen: boolean; boundary: string;
  onOpenFile?: (path: string) => void;
  onInspect?: (key: string) => void;
}) {
  const [open, toggle] = useDisclosure(defaultOpen, boundary);
  const id = useId();
  const result = entry.kind === 'tool' ? results.get(entry.call.id) : undefined;
  const failed = Boolean(result?.isError);
  const incomplete = entry.kind === 'tool' && !entry.live && !result;
  const state = failed ? 'is-error' : incomplete ? 'is-incomplete' : entry.live ? 'is-live is-running' : 'is-done';
  return <div className={'activity-row-item activity-row-' + entry.kind + ' ' + state}>
    <details open={open} className={'activity-disclosure activity-' + entry.kind + ' ' + state}>
      <summary className="activity-disclosure-summary" aria-expanded={open} aria-controls={id}
        aria-description={result && !failed ? '已完成' : undefined}
        onClick={event => { event.preventDefault(); onInspect?.(entry.key); toggle(); }}>
        <ActivitySummary entries={[entry]} results={results} expanded={open} onOpenFile={onOpenFile} />
        {images && images.length > 0 && <span className="activity-step-image-badge" title={`包含 ${images.length} 张截图`}>
          <ImageIcon aria-hidden="true" /><span>{images.length}</span>
        </span>}
        <ActivityStatus failed={Number(failed)} incomplete={Number(incomplete)} running={entry.live && entry.kind === 'tool'} />
        <ChevronDown className="activity-disclosure-chevron" aria-hidden="true" />
      </summary>
      <div id={id}>{open && <ActivityDetails entry={entry} result={result} onOpenFile={onOpenFile} />}</div>
    </details>
    {images && images.length > 0 && (
      <div className="activity-step-images">
        <ConversationImageGallery className="is-inline-step" images={images} />
      </div>
    )}
  </div>;
}

const ActivityRow = memo(ActivityRowComponent);

function TurnActivityComponent({ entries, results, toolImages, live, active, policy, density, onOpenFile }: ActivityProps) {
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
  const imageCount = useMemo(() => {
    if (!toolImages || toolImages.size === 0) return 0;
    let total = 0;
    for (const entry of entries) {
      if (entry.kind === 'tool') total += toolImages.get(entry.call.id)?.length ?? 0;
    }
    return total;
  }, [entries, toolImages]);
  // Long live or completed sequences only mount the steps the reader needs right now.
  const { visible, hiddenCount: hidden } = useMemo(() => selectVisibleActivityEntries(entries, {
    live,
    active,
    expandedHistory,
    density,
    inspected,
    results,
  }), [active, density, entries, expandedHistory, inspected, live, results]);
  const inspectEntry = useCallback((key: string) => {
    setInspected((previous) => (previous.has(key) ? previous : new Set(previous).add(key)));
  }, []);
  return <section className={'turn-trace' + (grouped ? ' is-grouped' : ' is-single')} aria-label="执行记录">
    {grouped && <button type="button" ref={heading} className="turn-trace-toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
      <ActivitySummary entries={entries} results={results} imageCount={imageCount} />
      {!open && <ActivityStatus failed={failed} incomplete={incomplete} running={running} grouped />}
      <ChevronDown className="activity-disclosure-chevron" aria-hidden="true" />
    </button>}
    <div className="activity-sequence" id={id} hidden={grouped && !open}>
      {(!grouped || open || visited) && <>
        {hidden > 0 && <button type="button" className="activity-earlier" onClick={() => setExpandedHistory(true)}>查看此前 {hidden} 个步骤</button>}
        {visible.map(entry => <ActivityRow key={entry.key} entry={entry} results={results}
          images={entry.kind === 'tool' ? toolImages?.get(entry.call.id) : undefined}
          boundary={boundary} onOpenFile={onOpenFile}
          onInspect={live ? inspectEntry : undefined}
          defaultOpen={showDuringTurn && (density === 'detailed' || (density !== 'compact' && entry.kind === 'thinking' && entry.live))} />)}
        {visible.length > 5 && open && <button type="button" className="activity-earlier turn-trace-collapse"
          onClick={() => { toggle(); heading.current?.focus(); }}>收起执行过程</button>}
      </>}
    </div>
  </section>;
}

export const TurnActivity = memo(TurnActivityComponent);

export function ToolResultImages({ callId, images, defaultOpen = true }: { callId: string; images: ConversationImage[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return <div className="tool-result-images" data-tool-call-id={callId}>
    <button type="button" className="tool-result-images-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <ImageIcon /><span>图像结果</span><span>{images.length}</span><ChevronDown className="activity-disclosure-chevron" />
    </button>
    <div id={id} hidden={!open}>{open && <ConversationImageGallery images={images} />}</div>
  </div>;
}
