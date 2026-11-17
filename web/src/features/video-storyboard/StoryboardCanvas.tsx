import { useEffect, useMemo } from 'react';
import dagre from '@dagrejs/dagre';
import { Background, ControlButton, Controls, getNodesBounds, getViewportForBounds, Handle, Position, ReactFlow, useReactFlow, useStore } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { Check, GitBranch, Lightbulb, MessageCircle, Paperclip, ClipboardList, Scan } from 'lucide-react';
import type { StoryboardDocument, StoryboardNode } from '../../types/storyboard-types';
import '@xyflow/react/dist/style.css';

export const stepLabels = { idea: '创作起点', question: '补充想法', direction: '讨论方向', materials: '安排素材', review: '核对方案' };
export const stepIcons = { idea: Lightbulb, question: MessageCircle, direction: GitBranch, materials: Paperclip, review: ClipboardList };
const cardWidth = 186;
const cardHeight = 62;
type Card = Node<{ node: StoryboardNode; approved: boolean; selected: boolean; caption: string }>;

function nodeCaption(node: StoryboardNode, idea: string) {
  if (node.kind === 'idea') return idea || node.question;
  const step = node.step;
  if (node.kind === 'direction' && step?.options?.length) return step.options.map(option => option.title).join(' / ');
  if (node.kind === 'materials' && step?.direction?.need) return step.direction.need.label;
  if (node.kind === 'review' && step?.direction) return step.direction.title;
  return node.question || step?.reply || node.answer;
}

function StepCard({ data }: NodeProps<Card>) {
  const { node, approved, selected } = data;
  const Icon = stepIcons[node.kind];
  const caption = data.caption;
  return <button type="button" className="story-flow-card nodrag nopan" aria-pressed={selected}
    aria-label={`${stepLabels[node.kind]} · ${caption}`} title={caption}>
    {node.parentId && <Handle type="target" position={Position.Top} />}
    <span className="story-node-icon"><Icon aria-hidden /></span>
    <strong>{stepLabels[node.kind]}{approved && <Check aria-label="已确认" />}</strong>
    <small>{caption}</small>
    <Handle type="source" position={Position.Bottom} />
  </button>;
}

const nodeTypes = { planning: StepCard };

type PlacedNode = Node & { width: number; height: number };

function CanvasControls({ graph, selected, parentId }: { graph: PlacedNode[]; selected: string; parentId: string | null }) {
  const { setViewport, viewportInitialized } = useReactFlow();
  const width = useStore(state => state.width);
  const height = useStore(state => state.height);
  const selectedBounds = useMemo(() => getNodesBounds(graph.filter(node => node.id === selected || node.id === parentId)), [graph, selected, parentId]);
  useEffect(() => {
    if (!viewportInitialized || !width || !height) return;
    void setViewport(getViewportForBounds(selectedBounds, width, height, 0.15, 1, 0.18));
  }, [selectedBounds, width, height, viewportInitialized, setViewport]);
  function showAll() {
    void setViewport(getViewportForBounds(getNodesBounds(graph), width, height, 0.15, 1, 0.2));
  }
  return <Controls showInteractive={false} showFitView={false} position="bottom-left" orientation="horizontal">
    <ControlButton title="查看完整流程" aria-label="查看完整流程" onClick={showAll}><Scan /></ControlButton>
  </Controls>;
}

export function StoryboardCanvas({ id, doc, selected, rootText, onSelect }: {
  id: string; doc: StoryboardDocument; selected: StoryboardNode; rootText: string; onSelect: (id: string) => void;
}) {
  const graph = useMemo(() => {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 38 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of doc.nodes) {
      graph.setNode(node.id, { width: cardWidth, height: cardHeight });
      if (node.parentId) graph.setEdge(node.parentId, node.id);
    }
    dagre.layout(graph);
    return doc.nodes.map(node => {
      const point = graph.node(node.id);
      return { id: node.id, type: 'planning', width: cardWidth, height: cardHeight,
        position: { x: point.x - cardWidth / 2, y: point.y - cardHeight / 2 }, data: { node } };
    });
  }, [doc.nodes]);
  const nodes: Card[] = graph.map(({ data: { node }, ...geometry }) => ({ ...geometry,
    data: { node, caption: nodeCaption(node, rootText), selected: node.id === selected.id, approved: Boolean(node.chosenPlanId && node.chosenPlanId === doc.approvedPlanId) } }));
  const ancestry = new Set<string>();
  const byId = new Map(doc.nodes.map(node => [node.id, node]));
  let current: StoryboardNode | undefined = selected;
  while (current?.parentId && !ancestry.has(current.id)) {
    ancestry.add(current.id);
    current = byId.get(current.parentId);
  }
  const edges = doc.nodes.flatMap(node => node.parentId ? [{
    id: node.id, source: node.parentId, target: node.id, type: 'smoothstep',
    className: ancestry.has(node.id) ? 'story-selected-edge' : '',
  }] : []);
  return <section id={id} className="story-canvas" aria-label="创作流程图">
    <ReactFlow nodes={nodes} onNodeClick={(_event, node) => onSelect(node.id)} edges={edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false}
      nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} zoomOnDoubleClick={false}
      minZoom={0.15} maxZoom={1.8}
      ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': '放大流程图', 'controls.zoomOut.ariaLabel': '缩小流程图' }}>
      <Background gap={18} size={1} color="var(--border-strong)" />
      <CanvasControls graph={graph} selected={selected.id} parentId={selected.parentId} />
    </ReactFlow>
  </section>;
}
