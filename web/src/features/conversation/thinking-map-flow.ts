import { getViewportForBounds, MarkerType, Position, type Dimensions, type Edge, type Node } from '@xyflow/react';
import type { ThinkingMapNode, ThinkingMapNodeStatus } from './thinking-map-model.ts';

export const THINKING_MAP_NODE = { width: 196, height: 68 };
export const THINKING_MAP_MIN_ZOOM = 0.1;
export const THINKING_MAP_PADDING = 20;
export const THINKING_MAP_FIT_OPTIONS = { padding: `${THINKING_MAP_PADDING}px`, maxZoom: 1 } as const;
export const THINKING_MAP_READABLE_ZOOM = 0.76;
const COLUMN_GAP = 30;
const ROW_GAP = 28;

export type ThinkingFlowNode = Node<{
  step: ThinkingMapNode;
  index: number;
  selected: boolean;
  hasNext: boolean;
}, 'thinkingStep'>;

export function thinkingEdgeState(status: ThinkingMapNodeStatus) {
  if (status === 'running') return 'active';
  if (status === 'error') return 'error';
  if (status === 'incomplete' || status === 'pending') return 'attention';
  return 'settled';
}

export function buildThinkingMapFlow(steps: readonly ThinkingMapNode[], canvasWidth: number, selectedId?: string) {
  const rowWidth = (canvasWidth - THINKING_MAP_PADDING * 2) / 0.88;
  const fittingColumns = Math.floor((rowWidth + COLUMN_GAP) / (THINKING_MAP_NODE.width + COLUMN_GAP));
  const columns = Math.max(1, Math.min(3, steps.length, fittingColumns));
  const rows = Math.ceil(steps.length / columns);
  const nodes: ThinkingFlowNode[] = steps.map((step, index) => {
    const row = Math.floor(index / columns);
    const slot = index % columns;
    const forward = row % 2 === 0;
    const column = forward ? slot : columns - slot - 1;
    return {
      id: step.id,
      type: 'thinkingStep',
      position: {
        x: column * (THINKING_MAP_NODE.width + COLUMN_GAP),
        y: row * (THINKING_MAP_NODE.height + ROW_GAP),
      },
      // At each row break the next step is directly below the previous one.
      sourcePosition: slot === columns - 1 ? Position.Bottom : forward ? Position.Right : Position.Left,
      targetPosition: slot === 0 ? Position.Top : forward ? Position.Left : Position.Right,
      ...THINKING_MAP_NODE,
      data: { step, index, selected: step.id === selectedId, hasNext: index < steps.length - 1 },
    };
  });
  const edges: Edge[] = steps.slice(1).map((step, index) => {
    const previous = steps[index];
    return {
      id: previous.id + '->' + step.id,
      source: previous.id,
      target: step.id,
      type: 'smoothstep',
      animated: step.status === 'running' || previous.status === 'running',
      className: 'thinking-map-edge is-' + thinkingEdgeState(step.status),
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: 'var(--border-hover)' },
    };
  });
  return {
    nodes,
    edges,
    bounds: {
      x: 0,
      y: 0,
      width: nodes.length ? columns * (THINKING_MAP_NODE.width + COLUMN_GAP) - COLUMN_GAP : 0,
      height: rows ? rows * (THINKING_MAP_NODE.height + ROW_GAP) - ROW_GAP : 0,
    },
  };
}

export function thinkingMapViewport(graph: ReturnType<typeof buildThinkingMapFlow>, size: Dimensions, selected?: ThinkingFlowNode) {
  const { padding, maxZoom } = THINKING_MAP_FIT_OPTIONS;
  const overview = getViewportForBounds(graph.bounds, size.width, size.height, THINKING_MAP_MIN_ZOOM, maxZoom, padding);
  if (!selected || overview.zoom >= THINKING_MAP_READABLE_ZOOM) return overview;
  return focusThinkingMapStep(graph.bounds, size, selected);
}

export function focusThinkingMapStep(bounds: Dimensions, size: Dimensions, selected: ThinkingFlowNode, maxZoom: number = THINKING_MAP_FIT_OPTIONS.maxZoom) {
  const view = getViewportForBounds(
    { ...selected.position, ...THINKING_MAP_NODE }, size.width, size.height,
    THINKING_MAP_MIN_ZOOM, maxZoom, THINKING_MAP_FIT_OPTIONS.padding,
  );
  // Center an axis that fits and keep the start and end of a long axis inside the frame.
  const align = (offset: number, remaining: number) => remaining >= 0 ? remaining / 2
    : Math.min(THINKING_MAP_PADDING, Math.max(remaining - THINKING_MAP_PADDING, offset));
  return {
    x: align(view.x, size.width - bounds.width * view.zoom),
    y: align(view.y, size.height - bounds.height * view.zoom),
    zoom: view.zoom,
  };
}
