/**
 * The subagent flow is a real graph canvas rather than a hand-built axis:
 * one parent node, one node per direct child, and status-aware edges.
 *
 * React Flow owns pan, zoom, fit and edge routing; dagre owns the layout in
 * `subagent-flow.mjs`. Nodes stay non-draggable and non-connectable because
 * this view is a read-only projection of the registry.
 */
import { createContext, memo, useContext, useMemo } from 'react';
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { Bot, CheckCircle2, CircleX, LoaderCircle, MessageSquare, Pause, ChevronRight } from 'lucide-react';
import type { SubagentChild } from '../../types/subagent-types';
import type { ModelSelection } from '../../types/model-types';
import { buildSubagentFlow, flowCanvasHeight } from './subagent-flow.mjs';
import '@xyflow/react/dist/style.css';

const STATUS_LABEL: Record<SubagentChild['status'], string> = {
  pending: '等待启动',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  paused: '已暂停',
  waiting: '等待回复',
};

type MemberData = { kind: 'member'; child: SubagentChild };
type RootData = { kind: 'root'; label: string };
type FlowNode = Node<MemberData | RootData>;

const NowContext = createContext<{ now: number }>({ now: Date.now() });

function statusIcon(status: SubagentChild['status']) {
  if (status === 'running' || status === 'pending') return <LoaderCircle className="spin" />;
  if (status === 'waiting') return <MessageSquare />;
  if (status === 'failed' || status === 'stopped') return <CircleX />;
  if (status === 'paused') return <Pause />;
  return <CheckCircle2 />;
}

function duration(value?: number): string {
  if (!value || value < 0) return '—';
  if (value < 1_000) return `${value}ms`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function liveDuration(child: SubagentChild, now: number): number | undefined {
  if (typeof child.durationMs === 'number') return child.durationMs;
  if (child.startedAt && ['running', 'pending', 'waiting'].includes(child.status)) {
    return Math.max(0, now - child.startedAt);
  }
  return undefined;
}

function tokenCount(value?: number): string {
  if (value === undefined) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

const RootNode = memo(function RootNode({ data }: NodeProps<Node<RootData>>) {
  return <div className="agent-flow-node is-root">
    <span className="agent-flow-avatar"><Bot /></span>
    <span className="agent-flow-identity">
      <small>主智能体</small>
      <strong>{data.label || '当前对话'}</strong>
    </span>
    <ChevronRight className="agent-flow-open" aria-hidden="true" />
    <Handle type="source" position={Position.Right} />
  </div>;
});

const MemberNode = memo(function MemberNode({ data }: NodeProps<Node<MemberData>>) {
  const { now } = useContext(NowContext);
  const child = data.child;
  const name = child.name || child.agent || `子智能体 ${child.index + 1}`;
  const stateLabel = child.currentTool || STATUS_LABEL[child.status] || child.status;
  const facts = [
    duration(liveDuration(child, now)),
    `${tokenCount(child.tokens)} tok`,
    child.referenceCostUsd !== undefined
      ? `$${child.referenceCostUsd.toFixed(child.referenceCostUsd < 1 ? 3 : 2)}`
      : '',
  ].filter(Boolean);
  return <div className={`agent-flow-node is-member is-${child.status}`}>
    <Handle type="target" position={Position.Left} />
    <span className="agent-flow-head">
      <span className={`agent-flow-status is-${child.status}`}>{statusIcon(child.status)}</span>
      <strong>{name}</strong>
      <span className="agent-flow-state" title={stateLabel}>{stateLabel}</span>
    </span>
    <span className="agent-flow-task" title={child.task}>{child.task}</span>
    <span className="agent-flow-facts">
      {child.error
        ? <span className="agent-flow-error" title={child.error}>{child.error}</span>
        : facts.map((fact) => <span key={fact}>{fact}</span>)}
    </span>
  </div>;
});

const nodeTypes = { agentRoot: RootNode, agentMember: MemberNode };

export function SubagentFlow({
  children,
  now,
  selection,
  onOpenChild,
  onReturnMain,
}: {
  children: SubagentChild[];
  now: number;
  selection: ModelSelection;
  onOpenChild: (child: SubagentChild) => void;
  onReturnMain: () => void;
}) {
  const rootLabel = selection.label || selection.modelRef || '';
  const graph = useMemo(
    () => buildSubagentFlow(children, { rootLabel }),
    // The registry array is replaced on every refresh, so the geometry is
    // rebuilt with it; node sizes are fixed, which keeps positions stable.
    [children, rootLabel],
  );
  const childByKey = useMemo(
    () => new Map(children.map((child) => [String(child.key), child])),
    [children],
  );
  const nodes = useMemo(
    () => graph.nodes.map((node) => node.type === 'agentRoot'
      ? { ...node, data: { kind: 'root' as const, label: rootLabel } }
      : node),
    [graph.nodes, rootLabel],
  );

  return <section
    className="agent-flow"
    aria-label="子智能体流程图"
    style={{ height: `${flowCanvasHeight(graph.height)}px` }}
  >
    <NowContext.Provider value={{ now }}>
      <ReactFlow
        nodes={nodes as FlowNode[]}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        minZoom={0.4}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        nodesFocusable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        onNodeClick={(_event, node) => {
          if (node.type === 'agentRoot') {
            onReturnMain();
            return;
          }
          const child = childByKey.get(node.id);
          if (child?.hasTranscript) onOpenChild(child);
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </NowContext.Provider>
  </section>;
}
