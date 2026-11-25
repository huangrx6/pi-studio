import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  getViewportForBounds,
  Handle,
  Position,
  ReactFlow,
  type Dimensions,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  ArrowDownToLine,
  Bot,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Globe,
  Image as ImageIcon,
  LoaderCircle,
  Pencil,
  Search,
  Sparkles,
  Terminal,
  Waypoints,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { Markdown } from '../../shared/Markdown';
import type { ChatMessage } from '../../types/chat-types';
import { ActivityDetails } from './ActivityDetails';
import { ActivitySummary } from './ActivitySummary';
import { ConversationImageGallery, type ConversationImage } from './ConversationImageGallery';
import {
  buildExecutionPhases,
  buildWrappedPhaseFlow,
  FLOW_WRAP_NODE_HEIGHT,
  FLOW_WRAP_NODE_WIDTH,
  type ExecutionFlowNode,
  type ExecutionPhase,
  type PhaseCategory,
  type PhaseStatus,
} from './execution-flow-model.ts';
import {
  buildThinkingMap,
  type ThinkingMapModel,
  type ThinkingMapNode,
  type ThinkingMapNodeKind,
  type ThinkingMapNodeStatus,
} from './thinking-map-model.ts';
import {
  buildThinkingMapFlow,
  focusThinkingMapStep,
  THINKING_MAP_FIT_OPTIONS,
  THINKING_MAP_MIN_ZOOM,
  THINKING_MAP_NODE,
  THINKING_MAP_PADDING,
  THINKING_MAP_READABLE_ZOOM,
  thinkingMapViewport,
  type ThinkingFlowNode,
} from './thinking-map-flow.ts';
import type { ActivityEntry } from './turn-content.ts';
import '@xyflow/react/dist/style.css';
import './styles/thinking-map.css';

type FlowViewMode = 'phase' | 'step';

const kindIcon: Record<ThinkingMapNodeKind, typeof Sparkles> = {
  thinking: Sparkles,
  explore: Search,
  write: Pencil,
  edit: Pencil,
  command: Terminal,
  search: Globe,
  fetch: Globe,
  browser: Globe,
  agent: Bot,
  image: ImageIcon,
  other: Wrench,
};

const phaseIcon: Record<PhaseCategory, typeof Sparkles> = {
  plan: Sparkles,
  explore: Search,
  edit: Pencil,
  command: Terminal,
  web: Globe,
  verify: ImageIcon,
  agent: Bot,
  image: ImageIcon,
  other: Wrench,
};

function statusLabel(status: ThinkingMapNodeStatus | PhaseStatus): string {
  if (status === 'running') return '进行中';
  if (status === 'error') return '失败';
  if (status === 'incomplete') return '未完成';
  if (status === 'pending') return '等待';
  return '完成';
}

function StatusGlyph({ status }: { status: ThinkingMapNodeStatus | PhaseStatus }) {
  if (status === 'running') return <LoaderCircle className="thinking-map-spin" aria-hidden="true" />;
  if (status === 'error') return <XCircle aria-hidden="true" />;
  if (status === 'incomplete') return <CircleAlert aria-hidden="true" />;
  if (status === 'pending') return <CircleDashed aria-hidden="true" />;
  return <CheckCircle2 aria-hidden="true" />;
}

const StepNode = memo(function StepNode({ data, sourcePosition, targetPosition }: NodeProps<ThinkingFlowNode>) {
  const { step, index, selected, hasNext } = data;
  const Icon = kindIcon[step.kind] || Wrench;
  return <button
    type="button"
    className={`thinking-map-node-card nodrag nopan is-${step.kind} is-${step.status}${selected ? ' is-selected' : ''}`}
    aria-pressed={selected}
    aria-label={`第 ${index + 1} 步 · ${step.title} · ${statusLabel(step.status)}`}
    title={step.preview || step.title}
  >
    {index > 0 && <Handle type="target" position={targetPosition ?? Position.Left} isConnectable={false} />}
    <span className="thinking-map-node-icon" aria-hidden="true"><Icon /></span>
    <span className="thinking-map-node-copy">
      <span className="thinking-map-node-title"><strong>{step.title}</strong><span>{index + 1}</span></span>
      <small>{step.preview || statusLabel(step.status)}</small>
    </span>
    <span className={`thinking-map-node-state is-${step.status}`}><StatusGlyph status={step.status} /></span>
    {hasNext && <Handle type="source" position={sourcePosition ?? Position.Right} isConnectable={false} />}
  </button>;
});

const PhaseNode = memo(function PhaseNode({ data, sourcePosition, targetPosition }: NodeProps<ExecutionFlowNode>) {
  const { phase, stepLabel, selected, hasPrev, hasNext } = data;
  const Icon = phaseIcon[phase.category] || Wrench;
  const thumb = phase.images[0];
  return <button
    type="button"
    className={`thinking-map-node-card is-phase nodrag nopan is-${phase.category} is-${phase.status}${selected ? ' is-selected' : ''}${thumb ? ' has-thumb' : ''}`}
    aria-pressed={selected}
    aria-label={`${stepLabel}. ${phase.title} · ${phase.summary}`}
    title={`${phase.title}：${phase.activeLabel || phase.summary}`}
  >
    {hasPrev && <Handle type="target" position={targetPosition ?? Position.Left} isConnectable={false} />}
    <span className="thinking-map-node-icon" aria-hidden="true"><Icon /></span>
    <span className="thinking-map-node-copy">
      <span className="thinking-map-node-title"><strong>{phase.title}</strong><span>{stepLabel}</span></span>
      <small>{phase.activeLabel || phase.summary}</small>
    </span>
    {thumb ? (
      <span className="thinking-map-node-thumb" aria-hidden="true">
        <img src={thumb.src} alt="" loading="lazy" decoding="async" />
        {phase.images.length > 1 && <span>+{phase.images.length - 1}</span>}
      </span>
    ) : (
      <span className={`thinking-map-node-state is-${phase.status}`}><StatusGlyph status={phase.status} /></span>
    )}
    {hasNext && <Handle type="source" position={sourcePosition ?? Position.Right} isConnectable={false} />}
  </button>;
});

const nodeTypes = { thinkingStep: StepNode, phaseNode: PhaseNode };

function StepDetail({ step }: { step: ThinkingMapNode }) {
  if (!step.detail.trim()) return <p className="thinking-map-detail-empty">这一步没有更多内容。</p>;
  if (step.kind === 'thinking') {
    return <div className="thinking-map-prose"><Markdown codeChrome={false} streaming={step.live}>{step.detail}</Markdown></div>;
  }
  return <pre className="thinking-map-detail-pre">{step.detail}</pre>;
}

function PhaseDetail({
  phase,
  results,
  onOpenFile,
}: {
  phase: ExecutionPhase;
  results: Map<string, ChatMessage>;
  onOpenFile?: (path: string) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'errors'>('all');
  const shownEntries = useMemo(() => {
    if (filter === 'errors') {
      return phase.entries.filter((entry) => entry.kind === 'tool' && results.get(entry.call.id)?.isError);
    }
    return phase.entries;
  }, [filter, phase.entries, results]);

  return (
    <div className="thinking-map-phase-detail">
      {phase.errorCount > 0 && (
        <div className="thinking-map-phase-filters">
          <button type="button" className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>
            全部步骤 ({phase.entries.length})
          </button>
          <button type="button" className={filter === 'errors' ? 'is-active' : ''} onClick={() => setFilter('errors')}>
            仅看失败 ({phase.errorCount})
          </button>
        </div>
      )}
      {phase.images.length > 0 && (
        <div className="thinking-map-phase-images">
          <ConversationImageGallery className="is-inline-step" images={phase.images} />
        </div>
      )}
      <div className="thinking-map-phase-steps">
        {shownEntries.map((entry, idx) => {
          const result = entry.kind === 'tool' ? results.get(entry.call.id) : undefined;
          const isError = Boolean(result?.isError);
          if (entry.kind === 'thinking') {
            return (
              <div key={entry.key} className="thinking-map-phase-step is-thinking">
                <div className="thinking-map-phase-step-meta">
                  <Sparkles aria-hidden="true" />
                  <strong>{entry.live ? '思考中' : '思考'}</strong>
                  <span>#{idx + 1}</span>
                </div>
                <div className="thinking-map-prose">
                  {entry.block.redacted
                    ? <p>模型未提供思考正文。</p>
                    : <Markdown codeChrome={false} streaming={entry.live}>{entry.block.thinking}</Markdown>}
                </div>
              </div>
            );
          }
          return (
            <details key={entry.key} open={isError || shownEntries.length <= 3} className={`thinking-map-phase-step is-tool${isError ? ' is-error' : ''}`}>
              <summary className="thinking-map-phase-step-summary">
                <ActivitySummary entries={[entry]} results={results} onOpenFile={onOpenFile} />
                {isError && <span className="thinking-map-step-badge is-error">失败</span>}
                {entry.live && <span className="thinking-map-step-badge is-running">执行中</span>}
              </summary>
              <ActivityDetails entry={entry} result={result} onOpenFile={onOpenFile} />
            </details>
          );
        })}
      </div>
    </div>
  );
}

function latestStep(nodes: readonly ThinkingMapNode[]) {
  for (let index = nodes.length - 1; index >= 0; index--) {
    if (nodes[index].live || nodes[index].status === 'running') return nodes[index];
  }
  return nodes.at(-1);
}

function latestPhase(phases: readonly ExecutionPhase[]) {
  for (let index = phases.length - 1; index >= 0; index--) {
    if (phases[index].status === 'running') return phases[index];
  }
  return phases.at(-1);
}

export function ThinkingMapDialog({
  model,
  entries,
  results,
  toolImages,
  onOpenFile,
  selectedId,
  initialPhaseId,
  onSelect,
  onClose,
}: {
  model: ThinkingMapModel;
  entries: ActivityEntry[];
  results: Map<string, ChatMessage>;
  toolImages?: ReadonlyMap<string, ConversationImage[]>;
  onOpenFile?: (path: string) => void;
  selectedId: string | null;
  initialPhaseId?: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLElement>(null);
  const flow = useRef<ReactFlowInstance<ThinkingFlowNode | ExecutionFlowNode> | null>(null);
  const fittedKey = useRef('');
  const [size, setSize] = useState<Dimensions>({ width: 0, height: 0 });
  const [mode, setMode] = useState<FlowViewMode>('phase');
  const phases = useMemo(() => buildExecutionPhases(entries, results, toolImages), [entries, results, toolImages]);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(() =>
    initialPhaseId === undefined ? latestPhase(phases)?.id ?? null : initialPhaseId);
  const activePhase = selectedPhaseId === null
    ? undefined
    : phases.find((p) => p.id === selectedPhaseId) ?? latestPhase(phases);

  const latest = latestStep(model.nodes);
  const selectedStep = selectedId === null ? undefined : model.nodes.find((node) => node.id === selectedId) ?? latest;

  const phaseGraph = useMemo(
    () => buildWrappedPhaseFlow(phases, size.width, activePhase?.id),
    [phases, size.width, activePhase?.id],
  );
  const stepGraph = useMemo(
    () => buildThinkingMapFlow(model.nodes, size.width, selectedStep?.id),
    [model.nodes, size.width, selectedStep?.id],
  );

  const activeGraph = mode === 'phase' ? phaseGraph : stepGraph;
  const initialViewport = useMemo(() => {
    if (size.width <= 0 || size.height <= 0) return undefined;
    if (mode === 'phase') {
      const overview = getViewportForBounds({ x: 0, y: 0, ...phaseGraph.bounds }, size.width, size.height, THINKING_MAP_MIN_ZOOM, 1, THINKING_MAP_PADDING);
      const selectedNode = phaseGraph.nodes.find((n) => n.data.selected);
      if (!selectedNode || overview.zoom >= THINKING_MAP_READABLE_ZOOM) return overview;
      const view = getViewportForBounds(
        { ...selectedNode.position, width: FLOW_WRAP_NODE_WIDTH, height: FLOW_WRAP_NODE_HEIGHT },
        size.width,
        size.height,
        THINKING_MAP_MIN_ZOOM,
        1,
        THINKING_MAP_PADDING,
      );
      const align = (offset: number, remaining: number) => remaining >= 0 ? remaining / 2
        : Math.min(THINKING_MAP_PADDING, Math.max(remaining - THINKING_MAP_PADDING, offset));
      return {
        x: align(view.x, size.width - phaseGraph.bounds.width * view.zoom),
        y: align(view.y, size.height - phaseGraph.bounds.height * view.zoom),
        zoom: view.zoom,
      };
    }
    const selectedStepNode = stepGraph.nodes.find((n) => n.data.selected);
    return thinkingMapViewport(stepGraph, size, selectedStepNode);
  }, [mode, phaseGraph, size, stepGraph]);

  const thoughts = model.nodes.filter((node) => node.kind === 'thinking' && node.detail.trim());
  const thoughtIndex = thoughts.findIndex((node) => node.id === selectedStep?.id);
  const nextThought = thoughts[thoughtIndex + 1] ?? thoughts[0];
  const firstErrorPhase = phases.find((p) => p.errorCount > 0);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = element;
      if (!width || !height) return;
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const key = `${mode}:${size.width}x${size.height}`;
    if (!flow.current || !initialViewport || fittedKey.current === key) return;
    fittedKey.current = key;
    void flow.current.setViewport(initialViewport);
  }, [mode, size, initialViewport]);

  function revealNode(id: string) {
    if (mode === 'phase') {
      setSelectedPhaseId(id);
      const instance = flow.current;
      const node = phaseGraph.nodes.find((item) => item.id === id);
      if (!instance || !node) return;
      const { x, y, zoom } = instance.getViewport();
      const left = x + node.position.x * zoom;
      const top = y + node.position.y * zoom;
      const padding = THINKING_MAP_PADDING / 2;
      if (zoom >= THINKING_MAP_READABLE_ZOOM && left >= padding && top >= padding
        && left + FLOW_WRAP_NODE_WIDTH * zoom <= size.width - padding
        && top + FLOW_WRAP_NODE_HEIGHT * zoom <= size.height - padding) return;
      const view = getViewportForBounds(
        { ...node.position, width: FLOW_WRAP_NODE_WIDTH, height: FLOW_WRAP_NODE_HEIGHT },
        size.width,
        size.height,
        THINKING_MAP_MIN_ZOOM,
        Math.max(1, zoom),
        THINKING_MAP_PADDING,
      );
      void instance.setViewport(view, { duration: 200 });
      return;
    }

    onSelect(id);
    const instance = flow.current;
    const node = stepGraph.nodes.find((item) => item.id === id);
    if (!instance || !node) return;
    const { x, y, zoom } = instance.getViewport();
    const left = x + node.position.x * zoom;
    const top = y + node.position.y * zoom;
    const padding = THINKING_MAP_PADDING / 2;
    if (zoom >= THINKING_MAP_READABLE_ZOOM && left >= padding && top >= padding
      && left + THINKING_MAP_NODE.width * zoom <= size.width - padding
      && top + THINKING_MAP_NODE.height * zoom <= size.height - padding) return;
    void instance.setViewport(focusThinkingMapStep(stepGraph.bounds, size, node, Math.max(THINKING_MAP_FIT_OPTIONS.maxZoom, zoom)));
  }

  const SelectedStepIcon = selectedStep ? kindIcon[selectedStep.kind] || Wrench : null;
  const SelectedPhaseIcon = activePhase ? phaseIcon[activePhase.category] || Wrench : null;
  const selectedPhaseNumber = activePhase ? phases.findIndex((p) => p.id === activePhase.id) + 1 : 0;
  const selectedStepNumber = selectedStep ? model.nodes.findIndex((n) => n.id === selectedStep.id) + 1 : 0;

  return <DetailDialog className={`thinking-map-dialog${phases.length <= 3 && mode === 'phase' ? ' is-compact' : ''}`} label="执行流程图" onClose={onClose}>{close => <>
    <header className="detail-header thinking-map-header">
      <div className="detail-heading">
        <span className="detail-icon" aria-hidden="true"><Waypoints /></span>
        <div>
          <h2>执行流程图</h2>
          <p>{[
            `${phases.length} 个阶段`,
            model.stats.tools > 0 && `${model.stats.tools} 次工具`,
            model.stats.thinking > 0 && `${model.stats.thinking} 次思考`,
            model.stats.errors > 0 && `${model.stats.errors} 步失败`,
            model.stats.running > 0 && `${model.stats.running} 步进行中`,
          ].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <div className="thinking-map-header-actions">
        <div className="thinking-map-mode-switch" role="tablist" aria-label="视图模式">
          <button type="button" role="tab" aria-selected={mode === 'phase'} className={mode === 'phase' ? 'is-active' : ''}
            onClick={() => setMode('phase')}>
            阶段流 ({phases.length})
          </button>
          <button type="button" role="tab" aria-selected={mode === 'step'} className={mode === 'step' ? 'is-active' : ''}
            onClick={() => setMode('step')}>
            全部步骤 ({model.nodes.length})
          </button>
        </div>
        {mode === 'phase' && firstErrorPhase && (
          <button type="button" className="thinking-map-navigation is-error" aria-label="定位失败" title="定位失败阶段"
            onClick={() => revealNode(firstErrorPhase.id)}>
            <XCircle aria-hidden="true" /><span>失败</span>
          </button>
        )}
        {mode === 'step' && (
          <button type="button" className="thinking-map-navigation" aria-label="定位思考" title="定位思考"
            disabled={!nextThought} onClick={() => { if (nextThought) revealNode(nextThought.id); }}>
            <Sparkles aria-hidden="true" /><span>思考</span>
          </button>
        )}
        <button type="button" className="thinking-map-navigation" aria-label="最新一步" title="最新"
          onClick={() => {
            const target = mode === 'phase' ? latestPhase(phases)?.id : latest?.id;
            if (target) revealNode(target);
          }}>
          <ArrowDownToLine aria-hidden="true" /><span>最新</span>
        </button>
        <button type="button" className="icon-button" aria-label="关闭流程图" title="关闭" onClick={close}>
          <X aria-hidden="true" />
        </button>
      </div>
    </header>
    <div className="thinking-map-layout">
      <section ref={canvas} className="thinking-map-canvas" aria-label="执行流程画布">
        {initialViewport && <ReactFlow<ThinkingFlowNode | ExecutionFlowNode>
          key={mode}
          nodes={activeGraph.nodes}
          edges={activeGraph.edges}
          nodeTypes={nodeTypes}
          defaultViewport={initialViewport}
          minZoom={THINKING_MAP_MIN_ZOOM}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          ariaLabelConfig={{
            'controls.zoomIn.ariaLabel': '放大',
            'controls.zoomOut.ariaLabel': '缩小',
            'controls.fitView.ariaLabel': '适配画布',
          }}
          onInit={instance => { flow.current = instance; fittedKey.current = `${mode}:${size.width}x${size.height}`; void instance.setViewport(initialViewport); }}
          onNodeClick={(_event, node) => revealNode(node.id)}
          onPaneClick={() => {
            if (mode === 'phase') setSelectedPhaseId(null);
            else onSelect(null);
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--divider)" />
          <Controls showInteractive={false} position="bottom-right" orientation="horizontal" fitViewOptions={THINKING_MAP_FIT_OPTIONS} aria-label="视图控制" />
        </ReactFlow>}
      </section>
      <aside className="thinking-map-detail" aria-label="节点详情">
        {mode === 'phase' ? (
          activePhase && SelectedPhaseIcon ? <>
            <div className={`thinking-map-detail-head is-${activePhase.category} is-${activePhase.status}`}>
              <span className="thinking-map-node-icon" aria-hidden="true"><SelectedPhaseIcon /></span>
              <div>
                <span className="thinking-map-detail-index">第 {selectedPhaseNumber} / {phases.length} 阶段</span>
                <h3>{activePhase.title}</h3>
              </div>
              <span className={`thinking-map-detail-status is-${activePhase.status}`}>
                <StatusGlyph status={activePhase.status} />{statusLabel(activePhase.status)}
              </span>
            </div>
            <div key={activePhase.id} className="thinking-map-detail-body" tabIndex={0}>
              <PhaseDetail phase={activePhase} results={results} onOpenFile={onOpenFile} />
            </div>
          </> : <p className="thinking-map-detail-empty">点击左侧任意阶段节点查看详情。</p>
        ) : (
          selectedStep && SelectedStepIcon ? <>
            <div className={`thinking-map-detail-head is-${selectedStep.kind} is-${selectedStep.status}`}>
              <span className="thinking-map-node-icon" aria-hidden="true"><SelectedStepIcon /></span>
              <div>
                <span className="thinking-map-detail-index">第 {selectedStepNumber} / {model.nodes.length} 步</span>
                <h3>{selectedStep.title}</h3>
              </div>
              <span className={`thinking-map-detail-status is-${selectedStep.status}`}>
                <StatusGlyph status={selectedStep.status} />{statusLabel(selectedStep.status)}
              </span>
            </div>
            <div key={selectedStep.id} className="thinking-map-detail-body" tabIndex={0}>
              <StepDetail step={selectedStep} />
            </div>
          </> : <p className="thinking-map-detail-empty">选择一个节点查看详情。</p>
        )}
      </aside>
    </div>
  </>}</DetailDialog>;
}

export function ThinkingMap({
  entries,
  results,
  toolImages,
  onOpenFile,
  live = false,
}: {
  entries: ActivityEntry[];
  results: Map<string, ChatMessage>;
  toolImages?: ReadonlyMap<string, ConversationImage[]>;
  onOpenFile?: (path: string) => void;
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const model = useMemo(() => buildThinkingMap(entries, results), [entries, results]);
  if (model.nodes.length === 0) return null;

  const label = live
    ? `执行流程图（进行中 · ${model.stats.total} 步）`
    : `执行流程图（${model.stats.total} 步）`;

  return <>
    <button type="button" className={`message-action thinking-map-trigger${live ? ' is-live' : ''}`}
      aria-haspopup="dialog" aria-label={label} title={label} onClick={() => {
        setSelectedId(current => model.nodes.some(node => node.id === current) ? current : latestStep(model.nodes)?.id ?? null);
        setOpen(true);
      }}>
      <Waypoints aria-hidden="true" />
    </button>
    {open && <ThinkingMapDialog
      model={model}
      entries={entries}
      results={results}
      toolImages={toolImages}
      onOpenFile={onOpenFile}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onClose={() => setOpen(false)}
    />}
  </>;
}
