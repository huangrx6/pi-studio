import { randomInt, randomUUID } from 'node:crypto';

const PALETTE = {
  neutral: ['#526174', '#edf2f7'],
  blue: ['#365d96', '#e5eefe'],
  teal: ['#23766e', '#e1f4ee'],
  purple: ['#6d53a3', '#eee7f9'],
  amber: ['#926217', '#fff1d7'],
};
const ID = /^[a-zA-Z0-9_.:-]{1,128}$/;
const NODE_TYPES = new Set(['rectangle', 'ellipse', 'diamond']);

function roughElement(id, type, x, y, width, height, strokeColor) {
  return {
    id, type, x, y, width, height, strokeColor,
    backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 1.6, strokeStyle: 'solid', roughness: 1, opacity: 100,
    angle: 0, seed: randomInt(1, 2 ** 31), version: 1, versionNonce: randomInt(1, 2 ** 31),
    isDeleted: false, boundElements: [], groupIds: [], frameId: null, roundness: null,
    updated: Date.now(), locked: false,
  };
}

function textUnits(text) {
  return [...text].reduce((units, char) => units + (/^[\u0020-\u007e]$/.test(char) ? .58 : 1), 0);
}

function textElement(id, text, centerX, centerY, fontSize, containerId = null) {
  const lines = text.split('\n');
  const width = Math.max(...lines.map(line => textUnits(line))) * fontSize;
  const height = lines.length * fontSize * 1.25;
  return {
    ...roughElement(id, 'text', centerX - width / 2, centerY - height / 2, width, height, '#263243'),
    text, originalText: text, fontSize, fontFamily: 5, textAlign: 'center',
    verticalAlign: containerId ? 'middle' : 'top', containerId, autoResize: true, lineHeight: 1.25,
  };
}

function wrapLabel(label, width) {
  return label.split('\n').flatMap(line => {
    const chunks = [];
    let row = '';
    const words = line.match(/[\x21-\x7e]+|./gu) || [];
    for (const token of words.flatMap(word => textUnits(word) > width ? [...word] : [word])) {
      if (row && textUnits(row + token) > width) {
        chunks.push(row.trim());
        row = '';
      }
      row += token;
    }
    return [...chunks, row.trim()];
  }).join('\n');
}

function layeredPositions(nodes, edges, horizontal, offset) {
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  const successors = new Map(nodes.map(node => [node.id, []]));
  for (const { from, to } of edges) {
    if (from === to || !nodesById.has(from) || !nodesById.has(to)) continue;
    incoming.set(to, incoming.get(to) + 1);
    successors.get(from).push(to);
  }
  const remaining = new Set(nodesById.keys());
  const width = Math.max(190, ...nodes.map(node => node.width)) + 92;
  const height = Math.max(70, ...nodes.map(node => node.height)) + 86;
  const positions = new Map();
  for (let layer = 0; remaining.size; layer += 1) {
    const ready = [...remaining].filter(id => incoming.get(id) === 0);
    // Break a cycle at its first declared node and keep its return edges.
    const rank = (ready.length ? ready : [[...remaining][0]]).slice(0, 4);
    rank.forEach((id, lane) => {
      remaining.delete(id);
      for (const next of successors.get(id)) incoming.set(next, incoming.get(next) - 1);
      const center = lane - (rank.length - 1) / 2;
      positions.set(id, horizontal
        ? [offset.x + layer * width, offset.y + center * height]
        : [offset.x + center * width, offset.y + layer * height]);
    });
  }
  return positions;
}

function radialPositions(nodes, central, offset) {
  const ring = nodes.slice(central ? 1 : 0);
  const radius = Math.max(240, (ring.length * 240) / (2 * Math.PI));
  const positions = new Map(ring.map(({ id }, index) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / ring.length;
    return [id, [offset.x + radius * Math.cos(angle), offset.y + radius * Math.sin(angle)]];
  }));
  if (central) positions.set(nodes[0].id, [offset.x, offset.y]);
  return positions;
}

function shapeCenter(shape) {
  return [shape.x + shape.width / 2, shape.y + shape.height / 2];
}

function edgeEndpoint(shape, toward) {
  const [x, y] = shapeCenter(shape);
  const dx = toward[0] - x;
  const dy = toward[1] - y;
  const wx = dx / (shape.width / 2 + 7);
  const hy = dy / (shape.height / 2 + 7);
  const divisor = shape.type === 'ellipse' ? Math.hypot(wx, hy)
    : shape.type === 'diamond' ? Math.abs(wx) + Math.abs(hy)
    : Math.max(Math.abs(wx), Math.abs(hy));
  return divisor ? [x + dx / divisor, y + dy / divisor] : [x, y];
}

function arrowGroup(edge, start, end, lane) {
  const id = `edge-${randomUUID()}`;
  const [sx, sy] = shapeCenter(start);
  const [ex, ey] = shapeCenter(end);
  const length = Math.hypot(ex - sx, ey - sy) || 1;
  const bend = [(sx + ex) / 2 + lane * (sy - ey) / length, (sy + ey) / 2 + lane * (ex - sx) / length];
  const from = edgeEndpoint(start, lane ? bend : [ex, ey]);
  const to = edgeEndpoint(end, lane ? bend : [sx, sy]);
  const route = start === end
    ? [
      [sx + start.width / 2 + 7, sy], [sx + start.width / 2 + 48 + Math.abs(lane), sy],
      [sx + start.width / 2 + 48 + Math.abs(lane), start.y - 42 - Math.abs(lane)],
      [sx, start.y - 42 - Math.abs(lane)], [sx, start.y - 7],
    ]
    : lane ? [from, bend, to] : [from, to];
  const [x, y] = route[0];
  const points = route.map(([nx, ny]) => [nx - x, ny - y]);
  const [xs, ys] = [points.map(p => p[0]), points.map(p => p[1])];
  const arrow = {
    ...roughElement(id, 'arrow', x, y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), '#526174'),
    points, startArrowhead: null, endArrowhead: edge.directed === false ? null : 'arrow',
    startBinding: { elementId: start.id, focus: 0, gap: 7 },
    endBinding: { elementId: end.id, focus: 0, gap: 7 },
    strokeStyle: edge.dashed ? 'dashed' : 'solid',
  };
  const label = edge.label?.trim();
  if (!label) return [arrow];
  const [lx, ly] = start === end ? route[2] : [(x + to[0]) / 2, (y + to[1]) / 2];
  const text = textElement(`${id}:label`, label, lx, ly - 6, 14, id);
  arrow.boundElements = [{ type: 'text', id: text.id }];
  return [arrow, text];
}

export function planDiagram(args, previous) {
  const nodes = (args.nodes || []).map(node => {
    const label = node.label.trim();
    if (!label || !ID.test(node.id) || node.id.length > 100) throw new Error('A node needs a short ID and a label.');
    const text = wrapLabel(label, node.shape === 'diamond' ? 12 : 19);
    const measuredWidth = Math.max(...text.split('\n').map(textUnits)) * 17;
    const width = node.shape === 'diamond'
      ? Math.max(184, (measuredWidth + 40) * 1.65)
      : Math.max(140, measuredWidth + 48);
    return { ...node, text, width, height: Math.max(64, text.split('\n').length * 22 + 32) };
  });
  const previousShapes = previous.filter(element => !element.isDeleted && NODE_TYPES.has(element.type));
  const shapes = new Map(previousShapes.map(element => [element.id, element]));
  const ids = new Set(previous.map(element => element.id));
  const edges = args.edges || [];
  const offset = {
    x: 60,
    y: 70 + Math.max(0, ...previousShapes.map(shape => shape.y + shape.height + 45)),
  };
  const layout = args.layout || 'flow';
  const horizontal = args.direction ? args.direction === 'LR' : layout === 'architecture';
  const positions = nodes.length && (layout === 'mindmap' || layout === 'network')
    ? radialPositions(nodes, layout === 'mindmap', offset)
    : layeredPositions(nodes, edges, horizontal, offset);
  const groups = [];
  for (const node of nodes) {
    const { id, text, width, height } = node;
    const labelId = `${id}:label`;
    if (ids.has(id) || ids.has(labelId)) throw new Error(`Node ID already exists: ${id}`);
    ids.add(id);
    ids.add(labelId);
    const [px, py] = positions.get(id);
    const x = node.x ?? px - width / 2;
    const y = node.y ?? py - height / 2;
    const type = node.shape || 'rectangle';
    const [stroke, fill] = PALETTE[node.color] || PALETTE.neutral;
    const shape = {
      ...roughElement(id, type, x, y, width, height, stroke),
      backgroundColor: fill, roundness: type === 'rectangle' ? { type: 3 } : null,
      boundElements: [{ type: 'text', id: labelId }],
    };
    shapes.set(id, shape);
    groups.push([shape, textElement(labelId, text, x + width / 2, y + height / 2, 17, id)]);
  }
  const routeKey = ({ from, to }) => [from, to].sort().join('\0');
  const parallels = new Map();
  for (const edge of edges) {
    const key = routeKey(edge);
    const pair = parallels.get(key) || [];
    pair.push(edge);
    parallels.set(key, pair);
  }
  for (const edge of edges) {
    const start = shapes.get(edge.from);
    const end = shapes.get(edge.to);
    if (!start || !end) throw new Error(`Connection endpoints must exist: ${edge.from} → ${edge.to}`);
    const pair = parallels.get(routeKey(edge));
    const index = pair.indexOf(edge);
    const lane = start === end ? index * 27
      : (index - (pair.length - 1) / 2) * 54 * (edge.from < edge.to ? 1 : -1);
    groups.push(arrowGroup(edge, start, end, lane));
  }
  if (!groups.length) throw new Error('Provide at least one node or connection to draw.');
  return groups;
}
