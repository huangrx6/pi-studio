import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
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

function statusLabel(status: ThinkingMapNodeStatus): string {
  if (status === 'running') return '进行中';
  if (status === 'error') return '失败';
  if (status === 'incomplete') return '未完成';
  if (status === 'pending') return '等待';
  return '完成';
}

function StatusGlyph({ status }: { status: ThinkingMapNodeStatus }) {
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

const nodeTypes = { thinkingStep: StepNode };

function StepDetail({ step }: { step: ThinkingMapNode }) {
  if (!step.detail.trim()) return <p className="thinking-map-detail-empty">这一步没有更多内容。</p>;
  if (step.kind === 'thinking') {
    return <div className="thinking-map-prose"><Markdown codeChrome={false} streaming={step.live}>{step.detail}</Markdown></div>;
  }
  return <pre className="thinking-map-detail-pre">{step.detail}</pre>;
}

function latestStep(nodes: readonly ThinkingMapNode[]) {
  for (let index = nodes.length - 1; index >= 0; index--) {
    if (nodes[index].live || nodes[index].status === 'running') return nodes[index];
  }
  return nodes.at(-1);
}

function ThinkingMapDialog({ model, selectedId, onSelect, onClose }: {
  model: ThinkingMapModel;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLElement>(null);
  const flow = useRef<ReactFlowInstance<ThinkingFlowNode> | null>(null);
  const fittedSize = useRef<Dimensions | null>(null);
  const [size, setSize] = useState<Dimensions>({ width: 0, height: 0 });
  const latest = latestStep(model.nodes);
  const selected = selectedId === null ? undefined : model.nodes.find(node => node.id === selectedId) ?? latest;
  const graph = useMemo(() => buildThinkingMapFlow(model.nodes, size.width, selected?.id), [model.nodes, size.width, selected?.id]);
  const selectedNode = graph.nodes.find(node => node.data.selected);
  const initialViewport = size.width > 0 && size.height > 0 ? thinkingMapViewport(graph, size, selectedNode) : undefined;
  const thoughts = model.nodes.filter(node => node.kind === 'thinking' && node.detail.trim());
  const thoughtIndex = thoughts.findIndex(node => node.id === selected?.id);
  const nextThought = thoughts[thoughtIndex + 1] ?? thoughts[0];

  useEffect(() => {
    const element = canvas.current!;
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = element;
      if (!width || !height) return;
      setSize(current => current.width === width && current.height === height ? current : { width, height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  // Refit only for a real viewport resize. Streaming updates can keep the current framing.
  useEffect(() => {
    if (!flow.current || !initialViewport || size === fittedSize.current) return;
    fittedSize.current = size;
    void flow.current.setViewport(initialViewport);
  }, [size, initialViewport]);

  function revealStep(id: string) {
    onSelect(id);
    const instance = flow.current;
    const node = graph.nodes.find(item => item.id === id);
    if (!instance || !node) return;
    const { x, y, zoom } = instance.getViewport();
    const left = x + node.position.x * zoom;
    const top = y + node.position.y * zoom;
    const padding = THINKING_MAP_PADDING / 2;
    if (zoom >= THINKING_MAP_READABLE_ZOOM && left >= padding && top >= padding
      && left + THINKING_MAP_NODE.width * zoom <= size.width - padding
      && top + THINKING_MAP_NODE.height * zoom <= size.height - padding) return;
    void instance.setViewport(focusThinkingMapStep(graph.bounds, size, node, Math.max(THINKING_MAP_FIT_OPTIONS.maxZoom, zoom)));
  }

  const SelectedIcon = selected ? kindIcon[selected.kind] || Wrench : null;
  return <DetailDialog className={`thinking-map-dialog${model.nodes.length <= 3 ? ' is-compact' : ''}`} label="思维链路" onClose={onClose}>{close => <>
    <header className="detail-header thinking-map-header">
      <div className="detail-heading">
        <span className="detail-icon" aria-hidden="true"><Waypoints /></span>
        <div>
          <h2>思维链路</h2>
          <p>{[
            model.stats.thinking > 0 && `${model.stats.thinking} 次思考`,
            model.stats.tools > 0 && `${model.stats.tools} 次工具`,
            model.stats.errors > 0 && `${model.stats.errors} 步失败`,
            model.stats.running > 0 && `${model.stats.running} 步进行中`,
          ].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <div className="thinking-map-header-actions">
        <button type="button" className="thinking-map-navigation" aria-label="定位思考" title="定位思考"
          disabled={!nextThought} onClick={() => { if (nextThought) revealStep(nextThought.id); }}>
          <Sparkles aria-hidden="true" /><span>定位思考</span>
        </button>
        <button type="button" className="thinking-map-navigation" aria-label="最新一步" title="最新一步"
          onClick={() => { if (latest) revealStep(latest.id); }}>
          <ArrowDownToLine aria-hidden="true" /><span>最新一步</span>
        </button>
        <button type="button" className="icon-button" aria-label="关闭思维链路" title="关闭思维链路" onClick={close}>
          <X aria-hidden="true" />
        </button>
      </div>
    </header>
    <div className="thinking-map-layout">
      <section ref={canvas} className="thinking-map-canvas" aria-label="思维链路图">
        {initialViewport && <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
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
          onInit={instance => { flow.current = instance; fittedSize.current = size; void instance.setViewport(initialViewport); }}
          onNodeClick={(_event, node) => revealStep(node.id)}
          onPaneClick={() => onSelect(null)}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border)" />
          <Controls showInteractive={false} position="bottom-right" orientation="horizontal" fitViewOptions={THINKING_MAP_FIT_OPTIONS} aria-label="视图控制" />
        </ReactFlow>}
      </section>
      <aside className="thinking-map-detail" aria-label="步骤详情">
        {selected && selectedNode && SelectedIcon ? <>
          <div className={`thinking-map-detail-head is-${selected.kind} is-${selected.status}`}>
            <span className="thinking-map-node-icon" aria-hidden="true"><SelectedIcon /></span>
            <div>
              <span className="thinking-map-detail-index">第 {selectedNode.data.index + 1} / {model.nodes.length} 步</span>
              <h3>{selected.title}</h3>
            </div>
            <span className={`thinking-map-detail-status is-${selected.status}`}>
              <StatusGlyph status={selected.status} />{statusLabel(selected.status)}
            </span>
          </div>
          <div key={selected.id} className="thinking-map-detail-body" tabIndex={0}>
            <StepDetail step={selected} />
          </div>
        </> : <p className="thinking-map-detail-empty">选择一个节点查看详情。</p>}
      </aside>
    </div>
  </>}</DetailDialog>;
}

export function ThinkingMap({ entries, results, live = false }: {
  entries: ActivityEntry[];
  results: Map<string, ChatMessage>;
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const model = useMemo(() => buildThinkingMap(entries, results), [entries, results]);
  if (model.nodes.length === 0) return null;

  const label = live
    ? `思维链路（进行中 · ${model.stats.total} 步）`
    : `思维链路（${model.stats.total} 步）`;

  return <>
    <button type="button" className={`message-action thinking-map-trigger${live ? ' is-live' : ''}`}
      aria-haspopup="dialog" aria-label={label} title={label} onClick={() => {
        setSelectedId(current => model.nodes.some(node => node.id === current) ? current : latestStep(model.nodes)?.id ?? null);
        setOpen(true);
      }}>
      <Waypoints aria-hidden="true" />
    </button>
    {open && <ThinkingMapDialog model={model} selectedId={selectedId} onSelect={setSelectedId} onClose={() => setOpen(false)} />}
  </>;
}
