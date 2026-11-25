import { memo, useMemo, useState } from 'react';
import {
  BookOpen,
  Bot,
  ChevronDown,
  Globe,
  Image as ImageIcon,
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
  type NarrativePhase,
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

  return (
    <li className={`narrative-step is-${step.icon}${isRunning ? ' is-running' : ''}${canExpand && expanded ? ' is-expanded' : ''}`}>
      <div className="narrative-step-line">
        <button
          type="button"
          className={`narrative-step-trigger${isDirectFileStep ? ' is-direct-file' : ''}`}
          aria-expanded={canExpand ? expanded : undefined}
          title={isDirectFileStep ? `在侧边栏打开 ${step.filePath}` : undefined}
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

      {step.liveThoughtExcerpt && !expanded && (
        <p className="narrative-step-thought">{step.liveThoughtExcerpt}</p>
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

function PhaseGroup({
  phase,
  results,
  defaultOpen,
  live,
  onOpenFile,
  onOpenChangeDiff,
}: {
  phase: NarrativePhase;
  results: Map<string, ChatMessage>;
  defaultOpen: boolean;
  live: boolean;
  onOpenFile?: (path: string) => void;
  onOpenChangeDiff?: (filePath?: string) => void;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [showEarlierSteps, setShowEarlierSteps] = useState(false);
  const [expandedStepKeys, setExpandedStepKeys] = useState<Set<string>>(() => new Set());

  const isOpen = userOpen ?? defaultOpen;
  const Icon = STEP_ICON[phase.icon] || Wrench;
  const isRunning = phase.status === 'running';

  // Single-step non-thinking phase renders cleanly as one direct row without double nesting.
  const only = phase.steps[0];
  if (phase.steps.length === 1 && only?.entry.kind === 'tool' && !isRunning) {
    const expanded = expandedStepKeys.has(only.key);
    return (
      <div className="narrative-group is-flat">
        <ul className="narrative-flat-list">
          <StepLeafRow
            step={only}
            result={results.get(only.entry.call.id)}
            expanded={expanded}
            onToggle={() => {
              setExpandedStepKeys((curr) => {
                const next = new Set(curr);
                if (next.has(only.key)) next.delete(only.key);
                else next.add(only.key);
                return next;
              });
            }}
            onOpenFile={onOpenFile}
            onOpenChangeDiff={onOpenChangeDiff}
          />
        </ul>
      </div>
    );
  }

  // While streaming, keep visible children bounded to the latest 6 steps unless user asks for earlier ones.
  const maxLiveSteps = 6;
  const hiddenCount = !showEarlierSteps && live && phase.steps.length > maxLiveSteps
    ? phase.steps.length - maxLiveSteps
    : 0;
  const visibleSteps = hiddenCount > 0 ? phase.steps.slice(-maxLiveSteps) : phase.steps;

  return (
    <div className={`narrative-group${isOpen ? ' is-open' : ''}${isRunning ? ' is-running' : ''}`}>
      <button
        type="button"
        className="narrative-group-trigger"
        aria-expanded={isOpen}
        onClick={() => setUserOpen(!isOpen)}
      >
        <span className={`narrative-icon is-${phase.icon}${phase.icon === 'agent' && !isRunning ? ' is-agent-done' : ''}`} aria-hidden="true">
          <Icon />
        </span>
        <span className="narrative-group-title">{phase.headline}</span>
        {phase.diff && (
          onOpenChangeDiff ? (
            <span
              role="button"
              tabIndex={0}
              className="narrative-inline-diff is-clickable"
              title="查看 Git 变更信息"
              aria-label={`查看本阶段变更（+${phase.diff.added} -${phase.diff.removed}）`}
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
              <span className="is-add">{`+${phase.diff.added}`}</span>
              <span className="is-del">{`-${phase.diff.removed}`}</span>
            </span>
          ) : (
            <span className="narrative-inline-diff">
              <span className="is-add">{`+${phase.diff.added}`}</span>
              <span className="is-del">{`-${phase.diff.removed}`}</span>
            </span>
          )
        )}
        {isRunning && <span className="narrative-running-dot" aria-hidden="true" />}
        <ChevronDown className="narrative-chevron" aria-hidden="true" />
      </button>

      {isOpen && (
        <div className="narrative-branch">
          {isRunning && phase.liveThought && !phase.steps.some((step) => step.liveThoughtExcerpt) && (
            <p className="narrative-branch-thought">{phase.liveThought}</p>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="narrative-earlier-btn"
              onClick={() => setShowEarlierSteps(true)}
            >
              查看较早的 {hiddenCount} 步
            </button>
          )}
          <ul className="narrative-step-list">
            {visibleSteps.map((step) => {
              const result = step.entry.kind === 'tool' ? results.get(step.entry.call.id) : undefined;
              const expanded = expandedStepKeys.has(step.key);
              return (
                <StepLeafRow
                  key={step.key}
                  step={step}
                  result={result}
                  expanded={expanded}
                  onToggle={() => {
                    setExpandedStepKeys((curr) => {
                      const next = new Set(curr);
                      if (next.has(step.key)) next.delete(step.key);
                      else next.add(step.key);
                      return next;
                    });
                  }}
                  onOpenFile={onOpenFile}
                  onOpenChangeDiff={onOpenChangeDiff}
                />
              );
            })}
          </ul>
        </div>
      )}
    </div>
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
  const phases = useMemo(
    () => buildNarrativePhases(entries, results, toolImages, cwd),
    [cwd, entries, results, toolImages],
  );

  if (phases.length === 0) return null;

  const activePhaseId = live
    ? ([...phases].reverse().find((phase) => phase.status === 'running') ?? phases.at(-1))?.id
    : undefined;

  return (
    <section
      className={`narrative-stream${live ? ' is-live' : ''}`}
      aria-label="执行进展"
    >
      {phases.map((phase) => {
        const defaultOpen = live
          ? phase.id === activePhaseId
          : (policy === 'keep-open' || density === 'detailed');
        return (
          <PhaseGroup
            key={phase.id}
            phase={phase}
            results={results}
            defaultOpen={defaultOpen}
            live={live}
            onOpenFile={onOpenFile}
            onOpenChangeDiff={onOpenChangeDiff}
          />
        );
      })}
    </section>
  );
}

export const NarrativeWorkstream = memo(NarrativeWorkstreamComponent);

export function NarrativePendingStatus({ label, retrying = false }: { label: string; retrying?: boolean }) {
  return (
    <div className={`narrative-pending${retrying ? ' is-retrying' : ''}`} role="status" aria-live="polite">
      <span className="narrative-running-dot" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
