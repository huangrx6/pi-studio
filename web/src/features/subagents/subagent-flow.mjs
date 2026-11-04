/**
 * Pure geometry for the subagent flow view.
 *
 * Studio forbids nested subagents, so the relationship is a single star: one
 * parent conversation and its direct children. The graph is laid out with
 * dagre so the parent stays vertically centred as the member list grows, and
 * the result is plain JSON that can be asserted without rendering React.
 */
import dagre from '@dagrejs/dagre';

export const FLOW_ROOT_NODE = { width: 236, height: 84 };
export const FLOW_MEMBER_NODE = { width: 296, height: 120 };
export const FLOW_ROOT_ID = 'main';
export const FLOW_MIN_HEIGHT = 320;
export const FLOW_MAX_HEIGHT = 560;
export const FLOW_PADDING = 24;

const ACTIVE_STATUSES = new Set(['running', 'pending']);

/**
 * Map a child status onto the edge treatment the renderer should use.
 * Kept here so tests can assert the visual contract without DOM access.
 */
export function flowEdgeState(status) {
  if (ACTIVE_STATUSES.has(status)) return 'active';
  if (status === 'failed' || status === 'stopped') return 'error';
  if (status === 'paused' || status === 'waiting') return 'attention';
  return 'settled';
}

export function buildSubagentFlow(children, { rootLabel = '' } = {}) {
  const list = Array.isArray(children) ? children : [];
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: 'LR',
    nodesep: 18,
    ranksep: 104,
    marginx: 8,
    marginy: 8,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setNode(FLOW_ROOT_ID, { ...FLOW_ROOT_NODE });

  const edges = [];
  const seen = new Set();
  for (const child of list) {
    const id = String(child.key);
    if (seen.has(id)) continue;
    seen.add(id);
    graph.setNode(id, { ...FLOW_MEMBER_NODE });
    graph.setEdge(FLOW_ROOT_ID, id, {});
    edges.push({
      id: `${FLOW_ROOT_ID}->${id}`,
      source: FLOW_ROOT_ID,
      target: id,
      type: 'smoothstep',
      animated: ACTIVE_STATUSES.has(child.status),
      className: `agent-flow-edge is-${flowEdgeState(child.status)}`,
      pathOptions: { borderRadius: 18, offset: 18 },
    });
  }

  dagre.layout(graph);

  // dagre only decides spacing, not which child reads "first". Pin the input
  // order onto the vertical slots so the graph matches the list sections.
  const memberIds = edges.map((edge) => edge.target);
  const slots = memberIds
    .map((id) => graph.node(id).y)
    .sort((left, right) => left - right);
  memberIds.forEach((id, index) => {
    graph.node(id).y = slots[index];
  });

  const place = (id, size) => {
    const point = graph.node(id);
    return {
      x: Math.round(point.x - size.width / 2),
      y: Math.round(point.y - size.height / 2),
    };
  };

  const nodes = [{
    id: FLOW_ROOT_ID,
    type: 'agentRoot',
    position: place(FLOW_ROOT_ID, FLOW_ROOT_NODE),
    draggable: false,
    selectable: false,
    data: { kind: 'root', label: rootLabel },
    width: FLOW_ROOT_NODE.width,
    height: FLOW_ROOT_NODE.height,
  }];

  for (const child of list) {
    const id = String(child.key);
    if (!seen.has(id)) continue;
    if (nodes.some((node) => node.id === id)) continue;
    nodes.push({
      id,
      type: 'agentMember',
      position: place(id, FLOW_MEMBER_NODE),
      draggable: false,
      selectable: false,
      data: { kind: 'member', child },
      width: FLOW_MEMBER_NODE.width,
      height: FLOW_MEMBER_NODE.height,
    });
  }

  const graphSize = graph.graph();
  return {
    nodes,
    edges,
    width: Math.max(FLOW_ROOT_NODE.width + FLOW_MEMBER_NODE.width + 180, Math.round(graphSize.width || 0)),
    height: Math.round(graphSize.height || 0),
  };
}

/** Canvas height that keeps a two-member graph compact without clipping more. */
export function flowCanvasHeight(graphHeight) {
  const needed = Number(graphHeight || 0) + FLOW_PADDING * 2;
  return Math.min(FLOW_MAX_HEIGHT, Math.max(FLOW_MIN_HEIGHT, Math.ceil(needed)));
}
