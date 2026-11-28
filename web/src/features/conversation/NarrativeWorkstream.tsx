import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  ChevronDown,
  Globe,
  Image as ImageIcon,
  ListTree,
  Maximize2,
  Pencil,
  Search,
  Sparkles,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { Markdown } from '../../shared/Markdown';
import type { StepCollapse, StepDisplay } from '../../shared/preferences';
import type { ChatMessage } from '../../types/chat-types';
import { ActivityDetails } from './ActivityDetails';
import { ConversationImagePreview, type ConversationImage } from './ConversationImageGallery';
import {
  buildNarrativePhases,
  formatTurnDuration,
  type NarrativeStepItem,
  type StepIconKind,
} from './narrative-stream-model.ts';
import type { ActivityEntry } from './turn-content.ts';
import './styles/narrative-workstream.css';

const STEP_ICON: Record<StepIconKind, typeof Search> = {
  thinking: Sparkles,
  read: BookOpen,
  search: Search,
  edit: Pencil,
  command: TerminalSquare,
  web: Globe,
  verify: ImageIcon,
  agent: Bot,
  other: Wrench,
};

function StepThumbStrip({ images }: { images: readonly ConversationImage[] }) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  if (images.length === 0) return null;

  return (
    <div className="narrative-shots" role="group" aria-label={`${images.length} 张过程截图`}>
      {images.slice(0, 4).map((image, index) => (
        <button
          key={`${index}-${image.src.slice(-28)}`}
          type="button"
          className="narrative-shot-tile"
          aria-label={`放大查看截图 ${index + 1}`}
          onClick={() => setPreviewIndex(index)}
        >
          <img src={image.src} alt={image.alt || ''} loading="lazy" decoding="async" draggable={false} />
          <span className="narrative-shot-zoom" aria-hidden="true"><Maximize2 /></span>
        </button>
      ))}
      {images.length > 4 && (
        <button
          type="button"
          className="narrative-shot-more"
          onClick={() => setPreviewIndex(4)}
        >
          +{images.length - 4}
        </button>
      )}
      {previewIndex !== null && (
        <ConversationImagePreview
          images={[...images]}
          index={previewIndex}
          onClose={() => setPreviewIndex(null)}
          onIndexChange={setPreviewIndex}
        />
      )}
    </div>
  );
}

function StepLeafRow({
  step,
  result,
  expanded,
  onToggle,
  onOpenFile,
  onOpenChangeDiff,
}: {
  step: NarrativeStepItem;
  result?: ChatMessage;
  expanded: boolean;
  onToggle: () => void;
  onOpenFile?: (path: string) => void;
  onOpenChangeDiff?: (filePath?: string) => void;
}) {
  const Icon = STEP_ICON[step.icon] || Wrench;
  const isRunning = step.status === 'running';
  const isThinking = step.entry.kind === 'thinking';
  const isDirectFileStep = Boolean(
    (step.icon === 'read' || step.icon === 'edit')
    && step.filePath
    && onOpenFile
    && step.status !== 'error',
  );
  const canExpand = !isDirectFileStep;
  const showLiveThought = Boolean(
    step.entry.kind === 'thinking'
    && isRunning
    && !expanded
    && !step.entry.block.redacted,
  );
  const liveThoughtRef = useRef<HTMLParagraphElement | null>(null);

  useLayoutEffect(() => {
    const el = liveThoughtRef.current;
    if (!el || !showLiveThought) return;
    el.scrollTop = el.scrollHeight;
  }, [showLiveThought, step.liveThoughtExcerpt]);

  return (
    <li className={`narrative-step is-${step.icon}${isRunning ? ' is-running' : ''}${canExpand && expanded ? ' is-expanded' : ''}`}>
      <div className="narrative-step-line">
        <button
          type="button"
          className={`narrative-step-trigger${isDirectFileStep ? ' is-direct-file' : ''}`}
          aria-expanded={canExpand ? expanded : undefined}
          title={isDirectFileStep ? `在会话标签中打开 ${step.filePath}` : undefined}
          onClick={() => {
            if (isDirectFileStep && step.filePath) {
              onOpenFile?.(step.filePath);
              return;
            }
            onToggle();
          }}
        >
          <span className={`narrative-icon is-${step.icon}`} aria-hidden="true"><Icon /></span>
          <span className="narrative-step-copy">
            {step.prefix && <span className="narrative-step-prefix">{step.prefix}</span>}
            {step.fileLabel && (
              onOpenFile && step.filePath && !isDirectFileStep ? (
                <span
                  role="link"
                  tabIndex={0}
                  className="narrative-file-link"
                  title={step.filePath}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenFile(step.filePath!);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenFile(step.filePath!);
                    }
                  }}
                >
                  {step.fileLabel}
                </span>
              ) : (
                <span className={isDirectFileStep ? 'narrative-file-link' : 'narrative-file-label'}>
                  {step.fileLabel}
                </span>
              )
            )}
            {step.detail && !(isThinking && expanded) && (
              <span className={`narrative-step-detail${step.icon === 'command' ? ' is-mono' : ''}`}>
                {step.detail}
              </span>
            )}
            {step.diff && (
              onOpenChangeDiff ? (
                <span
                  role="button"
                  tabIndex={0}
                  className="narrative-inline-diff is-clickable"
                  title="查看 Git 变更信息"
                  aria-label={`查看 ${step.fileLabel || '文件'} 的变更（+${step.diff.added} -${step.diff.removed}）`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenChangeDiff(step.filePath);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenChangeDiff(step.filePath);
                    }
                  }}
                >
                  <span className="is-add">{`+${step.diff.added}`}</span>
                  <span className="is-del">{`-${step.diff.removed}`}</span>
                </span>
              ) : (
                <span className="narrative-inline-diff">
                  <span className="is-add">{`+${step.diff.added}`}</span>
                  <span className="is-del">{`-${step.diff.removed}`}</span>
                </span>
              )
            )}
            {isRunning && <span className="narrative-running-dot" aria-hidden="true" />}
          </span>
          {canExpand && expanded && <ChevronDown className="narrative-step-chevron" aria-hidden="true" />}
        </button>
      </div>

      {showLiveThought && (
        <p ref={liveThoughtRef} className="narrative-step-thought">
          {step.liveThoughtExcerpt || ''}
        </p>
      )}

      {step.images.length > 0 && <StepThumbStrip images={step.images} />}

      {canExpand && expanded && (
        <div className={`narrative-step-body${isThinking ? ' is-thought-surface' : ''}`}>
          {step.entry.kind === 'thinking' ? (
            step.entry.block.redacted
              ? <p className="narrative-muted-note">模型未提供思考正文。</p>
              : <div className="narrative-thought-md"><Markdown codeChrome={false} streaming={step.entry.live}>{step.entry.block.thinking}</Markdown></div>
          ) : (
            <ActivityDetails entry={step.entry} result={result} onOpenFile={onOpenFile} />
          )}
        </div>
      )}
    </li>
  );
}

export type NarrativeWorkstreamProps = {
  entries: ActivityEntry[];
  results: Map<string, ChatMessage>;
  toolImages?: ReadonlyMap<string, ConversationImage[]>;
  cwd?: string;
  live: boolean;
  density?: StepDisplay;
  policy?: StepCollapse;
  onOpenFile?: (path: string) => void;
  onOpenChangeDiff?: (filePath?: string) => void;
};

function NarrativeWorkstreamComponent({
  entries,
  results,
  toolImages,
  cwd,
  live,
  density = 'standard',
  policy = 'after-answer',
  onOpenFile,
  onOpenChangeDiff,
}: NarrativeWorkstreamProps) {
  const contentId = useId();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [expandedStepKeys, setExpandedStepKeys] = useState<Set<string>>(() => new Set());
  const phases = useMemo(
    () => buildNarrativePhases(entries, results, toolImages, cwd),
    [cwd, entries, results, toolImages],
  );
  const allSteps = useMemo(
    () => phases.flatMap((phase) => phase.steps),
    [phases],
  );
  const aggregateDiff = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const step of allSteps) {
      if (step.diff) {
        added += step.diff.added;
        removed += step.diff.removed;
      }
    }
    return added > 0 || removed > 0 ? { added, removed } : undefined;
  }, [allSteps]);

  if (allSteps.length === 0) return null;

  const renderStep = (step: NarrativeStepItem) => (
    <StepLeafRow
      key={step.key}
      step={step}
      result={step.entry.kind === 'tool' ? results.get(step.entry.call.id) : undefined}
      expanded={expandedStepKeys.has(step.key)}
      onToggle={() => {
        setExpandedStepKeys((current) => {
          const next = new Set(current);
          if (!next.delete(step.key)) next.add(step.key);
          return next;
        });
      }}
      onOpenFile={onOpenFile}
      onOpenChangeDiff={onOpenChangeDiff}
    />
  );

  // Single step renders directly without a redundant collapsible wrapper.
  if (allSteps.length === 1) {
    return (
      <section className={`narrative-stream${live ? ' is-live' : ''}`} aria-label="执行进展">
        <div className="narrative-group is-flat">
          <ul className="narrative-flat-list">{renderStep(allSteps[0])}</ul>
        </div>
      </section>
    );
  }

  const singleToolPhase = phases.length === 1 && phases[0].toolCount > 0 ? phases[0] : null;
  const SummaryIcon = singleToolPhase ? (STEP_ICON[singleToolPhase.icon] || Wrench) : ListTree;
  const summaryTitle = singleToolPhase ? singleToolPhase.headline : '执行过程';
  const isRunning = live && allSteps.some((step) => step.status === 'running');
  const keepOpen = policy === 'keep-open' || density === 'detailed';
  const isOpen = userOpen ?? (live || keepOpen);

  return (
    <section
      className={`narrative-stream${live ? ' is-live' : ''}`}
      aria-label="执行进展"
    >
      <div className={`narrative-group${isOpen ? ' is-open' : ''}${isRunning ? ' is-running' : ''}`}>
        <button
          type="button"
          className="narrative-group-trigger narrative-stream-summary"
          aria-controls={contentId}
          aria-expanded={isOpen}
          onClick={() => setUserOpen(!isOpen)}
        >
          <span
            className={`narrative-icon${singleToolPhase ? ` is-${singleToolPhase.icon}${singleToolPhase.icon === 'agent' && !isRunning ? ' is-agent-done' : ''}` : ''}`}
            aria-hidden="true"
          >
            <SummaryIcon />
          </span>
          <span className="narrative-group-title">{summaryTitle}</span>
          {!singleToolPhase && <span className="narrative-stream-count">{allSteps.length} 步</span>}
          {aggregateDiff && (
            onOpenChangeDiff ? (
              <span
                role="button"
                tabIndex={0}
                className="narrative-inline-diff is-clickable"
                title="查看 Git 变更信息"
                aria-label={`查看本阶段变更（+${aggregateDiff.added} -${aggregateDiff.removed}）`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenChangeDiff();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenChangeDiff();
                  }
                }}
              >
                <span className="is-add">{`+${aggregateDiff.added}`}</span>
                <span className="is-del">{`-${aggregateDiff.removed}`}</span>
              </span>
            ) : (
              <span className="narrative-inline-diff">
                <span className="is-add">{`+${aggregateDiff.added}`}</span>
                <span className="is-del">{`-${aggregateDiff.removed}`}</span>
              </span>
            )
          )}
          {isRunning && <span className="narrative-running-dot" aria-hidden="true" />}
          <ChevronDown className="narrative-chevron" aria-hidden="true" />
        </button>

        <div className="narrative-branch" id={contentId} hidden={!isOpen}>
          {isOpen && <ul className="narrative-step-list">{allSteps.map(renderStep)}</ul>}
        </div>
      </div>
    </section>
  );
}

export const NarrativeWorkstream = memo(NarrativeWorkstreamComponent);

export function NarrativeLiveStatus({
  startedAt,
  retry,
}: {
  startedAt?: number;
  retry?: { attempt: number; maxAttempts: number };
}) {
  const [observedAt] = useState(Date.now);
  const [now, setNow] = useState(observedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const label = retry ? `正在重试请求（${retry.attempt}/${retry.maxAttempts}）` : 'Pi 正在处理';
  const start = startedAt !== undefined && startedAt > 0 ? startedAt : observedAt;
  const duration = formatTurnDuration(now - start) || '用时 0秒';
  return (
    <div className={`narrative-live-status${retry ? ' is-retrying' : ''}`}>
      <span className="pi-mark" aria-hidden="true" />
      <span role="status">{label}</span>
      <span aria-hidden="true">·</span>
      <span className="narrative-live-duration">{duration}</span>
      <span className="narrative-live-ellipsis" aria-hidden="true">…</span>
    </div>
  );
}
