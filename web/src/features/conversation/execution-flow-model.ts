import { MarkerType, Position, type Dimensions, type Edge, type Node } from '@xyflow/react';
import type { ChatMessage, ToolCallBlock } from '../../types/chat-types.ts';
import { toolResultDiff, writtenLineCount } from './file-changes.ts';
import { activityKind, type ActivityEntry } from './turn-content.ts';

export type ConversationImage = {
  src: string;
  alt?: string;
};

export type PhaseCategory =
  | 'plan'
  | 'explore'
  | 'edit'
  | 'command'
  | 'web'
  | 'verify'
  | 'agent'
  | 'image'
  | 'other';

export type PhaseStatus = 'running' | 'done' | 'error' | 'incomplete';

export type ExecutionPhase = {
  id: string;
  category: PhaseCategory;
  title: string;
  summary: string;
  entries: ActivityEntry[];
  images: ConversationImage[];
  status: PhaseStatus;
  errorCount: number;
  incompleteCount: number;
  toolCount: number;
  thoughtCount: number;
  activeLabel?: string;
  /** Non-empty when an agent phase fans out into 2-4 sub-branches. */
  subBranches?: Array<{
    id: string;
    label: string;
    status: PhaseStatus;
    entry: Extract<ActivityEntry, { kind: 'tool' }>;
  }>;
};

export type FlowPhaseNodeData = {
  phase: ExecutionPhase;
  stepLabel: string;
  selected: boolean;
  branchIndex?: number;
  branchTitle?: string;
  branchStatus?: PhaseStatus;
  hasPrev: boolean;
  hasNext: boolean;
};

export type ExecutionFlowNode = Node<FlowPhaseNodeData, 'phaseNode'>;

export const FLOW_NODE_WIDTH = 176;
export const FLOW_NODE_IMAGE_WIDTH = 204;
export const FLOW_NODE_HEIGHT = 56;
export const FLOW_WRAP_NODE_WIDTH = 212;
export const FLOW_WRAP_NODE_HEIGHT = 68;
export const FLOW_GAP_X = 28;
export const FLOW_GAP_Y = 24;

export function latestActivePhase(phases: readonly ExecutionPhase[]): ExecutionPhase | undefined {
  for (let index = phases.length - 1; index >= 0; index--) {
    if (phases[index].status === 'running') return phases[index];
  }
  return phases.at(-1);
}

export function summarizeTurnPhases(phases: readonly ExecutionPhase[], live: boolean): string {
  if (phases.length === 0) return '';
  const active = live ? latestActivePhase(phases) : undefined;
  if (active && live) {
    const label = active.activeLabel ? `${active.title} · ${active.activeLabel}` : `${active.title} · ${active.summary}`;
    return label;
  }
  const uniqueTitles: string[] = [];
  for (const phase of phases) {
    if (!uniqueTitles.includes(phase.title)) uniqueTitles.push(phase.title);
  }
  if (uniqueTitles.length === 1) return `${uniqueTitles[0]} · ${phases[0].summary}`;
  const headline = uniqueTitles.slice(0, 3).join('、');
  return uniqueTitles.length > 3 ? `${headline}等 ${phases.length} 阶段` : headline;
}

/** 2D wrapped serpentine flow graph for the spacious Flow Studio dialog. */
export function buildWrappedPhaseFlow(
  phases: readonly ExecutionPhase[],
  canvasWidth: number,
  selectedPhaseId?: string | null,
): {
  nodes: ExecutionFlowNode[];
  edges: Edge[];
  bounds: Dimensions;
} {
  if (phases.length === 0) {
    return { nodes: [], edges: [], bounds: { width: 0, height: 0 } };
  }
  const padding = 20;
  const usableWidth = Math.max(FLOW_WRAP_NODE_WIDTH, (canvasWidth - padding * 2) / 0.9);
  const fittingCols = Math.floor((usableWidth + FLOW_GAP_X) / (FLOW_WRAP_NODE_WIDTH + FLOW_GAP_X));
  const columns = Math.max(1, Math.min(3, phases.length, fittingCols));
  const rows = Math.ceil(phases.length / columns);

  const nodes: ExecutionFlowNode[] = phases.map((phase, index) => {
    const row = Math.floor(index / columns);
    const slot = index % columns;
    const forward = row % 2 === 0;
    const col = forward ? slot : columns - slot - 1;
    const isRowEnd = slot === columns - 1;
    const isRowStart = slot === 0;
    return {
      id: phase.id,
      type: 'phaseNode',
      position: {
        x: col * (FLOW_WRAP_NODE_WIDTH + FLOW_GAP_X),
        y: row * (FLOW_WRAP_NODE_HEIGHT + FLOW_GAP_Y),
      },
      width: FLOW_WRAP_NODE_WIDTH,
      height: FLOW_WRAP_NODE_HEIGHT,
      sourcePosition: isRowEnd ? Position.Bottom : forward ? Position.Right : Position.Left,
      targetPosition: isRowStart ? Position.Top : forward ? Position.Left : Position.Right,
      data: {
        phase,
        stepLabel: String(index + 1),
        selected: phase.id === selectedPhaseId,
        hasPrev: index > 0,
        hasNext: index < phases.length - 1,
      },
    };
  });

  const edges: Edge[] = phases.slice(1).map((phase, index) => {
    const prev = phases[index];
    return {
      id: `${prev.id}->${phase.id}`,
      source: prev.id,
      target: phase.id,
      type: 'smoothstep',
      animated: phase.status === 'running' || prev.status === 'running',
      className: `execution-flow-edge ${edgeClassForStatus(phase.status)}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11, color: 'var(--border-hover)' },
    };
  });

  return {
    nodes,
    edges,
    bounds: {
      width: columns * (FLOW_WRAP_NODE_WIDTH + FLOW_GAP_X) - FLOW_GAP_X,
      height: rows * (FLOW_WRAP_NODE_HEIGHT + FLOW_GAP_Y) - FLOW_GAP_Y,
    },
  };
}

const BROWSER_MCP_TOOLS = new Set([
  'new_page',
  'list_pages',
  'select_page',
  'close_page',
  'navigate_page',
  'take_snapshot',
  'take_screenshot',
  'click',
  'fill',
  'fill_form',
  'press_key',
  'evaluate_script',
  'wait_for',
  'hover',
  'resize_page',
  'drag',
  'upload_file',
  'get_console_message',
  'list_console_messages',
  'list_network_requests',
  'get_network_request',
]);

const PHASE_TITLES: Record<PhaseCategory, string> = {
  plan: '规划思考',
  explore: '探索源码',
  edit: '编写修改',
  command: '执行命令',
  web: '网页检索',
  verify: '界面验证',
  agent: '子智能体',
  image: '图像生成',
  other: '工具调用',
};

function shortText(value: unknown, limit = 64): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, limit);
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function toolFilePath(call: ToolCallBlock): string {
  const path = call.arguments?.path ?? call.arguments?.file_path;
  return typeof path === 'string' ? path : '';
}

function classifyToolCategory(
  call: ToolCallBlock,
  hasImages: boolean,
): PhaseCategory {
  if (hasImages) return 'verify';
  const kind = activityKind({ kind: 'tool', key: call.id, call, live: false });
  if (kind === 'explore') return 'explore';
  if (kind === 'write' || kind === 'edit') return 'edit';
  if (kind === 'command') return 'command';
  if (kind === 'search' || kind === 'fetch') return 'web';
  if (kind === 'browser') return 'verify';
  if (kind === 'agent') return 'agent';
  if (kind === 'image') return 'image';
  const baseName = call.name.split('__').at(-1) || call.name;
  if (BROWSER_MCP_TOOLS.has(baseName)) return 'verify';
  return 'other';
}

function entryStatus(entry: ActivityEntry, results: Map<string, ChatMessage>): PhaseStatus {
  if (entry.kind === 'thinking') return entry.live ? 'running' : 'done';
  if (entry.live) return 'running';
  const result = results.get(entry.call.id);
  if (!result) return 'incomplete';
  return result.isError ? 'error' : 'done';
}

function liveActionLabel(entry: ActivityEntry): string {
  if (entry.kind === 'thinking') return '思考下一步…';
  const args = entry.call.arguments || {};
  const preview = shortText(
    args.command || toolFilePath(entry.call) || args.url || args.query || args.name || args.action,
    42,
  );
  return preview || entry.call.name.split('__').at(-1) || entry.call.name;
}

function summarizePhase(
  category: PhaseCategory,
  entries: ActivityEntry[],
  images: ConversationImage[],
  results: Map<string, ChatMessage>,
): Pick<ExecutionPhase, 'title' | 'summary' | 'status' | 'errorCount' | 'incompleteCount' | 'toolCount' | 'thoughtCount' | 'activeLabel' | 'subBranches'> {
  const calls: Extract<ActivityEntry, { kind: 'tool' }>[] = [];
  let thoughtCount = 0;
  let errorCount = 0;
  let incompleteCount = 0;
  let runningEntry: ActivityEntry | undefined;

  for (const entry of entries) {
    if (entry.kind === 'thinking') {
      thoughtCount++;
      if (entry.live) runningEntry = entry;
    } else {
      calls.push(entry);
      const status = entryStatus(entry, results);
      if (status === 'running') runningEntry = entry;
      else if (status === 'error') errorCount++;
      else if (status === 'incomplete') incompleteCount++;
    }
  }

  const status: PhaseStatus = runningEntry
    ? 'running'
    : errorCount > 0
      ? 'error'
      : incompleteCount > 0
        ? 'incomplete'
        : 'done';

  let title = PHASE_TITLES[category];
  let summary = '';

  if (category === 'plan') {
    title = runningEntry ? '正在思考' : '规划思考';
    const firstThought = entries.find((entry): entry is Extract<ActivityEntry, { kind: 'thinking' }> => entry.kind === 'thinking');
    summary = firstThought?.block.redacted
      ? '推理中'
      : shortText(firstThought?.block.thinking, 48) || `${thoughtCount} 段思考`;
  } else if (category === 'explore') {
    const files = new Set(calls.map((c) => toolFilePath(c.call)).filter(Boolean));
    if (files.size > 0) summary = files.size === 1 ? basename([...files][0]) : `${files.size} 个文件 · ${calls.length} 次`;
    else summary = `${calls.length} 次读查`;
  } else if (category === 'edit') {
    const files = new Set(calls.map((c) => toolFilePath(c.call)).filter(Boolean));
    let added = 0;
    let removed = 0;
    for (const c of calls) {
      const res = results.get(c.call.id);
      if (!res || res.isError) continue;
      const diff = toolResultDiff(res);
      if (diff) {
        added += diff.added;
        removed += diff.removed;
      } else if (c.call.name === 'write' && typeof c.call.arguments?.content === 'string') {
        added += writtenLineCount(c.call.arguments.content);
      }
    }
    const fileLabel = files.size > 0 ? `${files.size} 文件` : `${calls.length} 次写入`;
    summary = (added > 0 || removed > 0) ? `${fileLabel} · +${added} -${removed}` : fileLabel;
  } else if (category === 'command') {
    const lastCmd = shortText(calls.at(-1)?.call.arguments?.command, 36);
    summary = calls.length === 1 && lastCmd ? lastCmd : `${calls.length} 条命令`;
  } else if (category === 'verify') {
    if (images.length > 0) summary = `${images.length} 张截图 · ${calls.length} 步`;
    else summary = `${calls.length} 次页面操作`;
  } else if (category === 'web') {
    const lastQuery = shortText(calls.at(-1)?.call.arguments?.query || calls.at(-1)?.call.arguments?.url, 36);
    summary = calls.length === 1 && lastQuery ? lastQuery : `${calls.length} 次检索`;
  } else if (category === 'agent') {
    summary = `${calls.length} 个任务`;
  } else {
    summary = `${calls.length} 次调用`;
  }

  if (errorCount > 0 && status === 'error') {
    summary = `${errorCount} 项失败 · ${summary}`;
  }

  let subBranches: ExecutionPhase['subBranches'];
  if (category === 'agent' && calls.length >= 2 && calls.length <= 4) {
    subBranches = calls.map((entry, idx) => {
      const args = entry.call.arguments || {};
      const name = shortText(args.role || args.name || args.agent || args.task || args.action, 28) || `子任务 ${idx + 1}`;
      return {
        id: entry.key,
        label: name,
        status: entryStatus(entry, results),
        entry,
      };
    });
  }

  return {
    title,
    summary,
    status,
    errorCount,
    incompleteCount,
    toolCount: calls.length,
    thoughtCount,
    activeLabel: runningEntry ? liveActionLabel(runningEntry) : undefined,
    subBranches,
  };
}

/**
 * Group chronological activity entries into semantic phases while keeping strict temporal order.
 * Completed node IDs are anchored to their first entry key so live streaming never shifts past nodes.
 */
export function buildExecutionPhases(
  entries: ActivityEntry[],
  results: Map<string, ChatMessage>,
  toolImages?: ReadonlyMap<string, ConversationImage[]>,
): ExecutionPhase[] {
  const buckets: Array<{ id: string; category: PhaseCategory; entries: ActivityEntry[]; images: ConversationImage[] }> = [];
  let pendingThoughts: ActivityEntry[] = [];

  for (const entry of entries) {
    if (entry.kind === 'thinking') {
      pendingThoughts.push(entry);
      continue;
    }
    const images = toolImages?.get(entry.call.id) ?? [];
    const category = classifyToolCategory(entry.call, images.length > 0);
    const previous = buckets.at(-1);
    if (previous && previous.category === category) {
      if (pendingThoughts.length > 0) {
        previous.entries.push(...pendingThoughts);
        pendingThoughts = [];
      }
      previous.entries.push(entry);
      if (images.length > 0) previous.images.push(...images);
    } else {
      const bucketEntries = [...pendingThoughts, entry];
      const anchorId = (pendingThoughts[0] ?? entry).key;
      pendingThoughts = [];
      buckets.push({
        id: `phase-${anchorId}`,
        category,
        entries: bucketEntries,
        images: [...images],
      });
    }
  }

  if (pendingThoughts.length > 0) {
    buckets.push({
      id: `phase-${pendingThoughts[0].key}`,
      category: 'plan',
      entries: pendingThoughts,
      images: [],
    });
  }

  return buckets.map((bucket) => ({
    id: bucket.id,
    category: bucket.category,
    entries: bucket.entries,
    images: bucket.images,
    ...summarizePhase(bucket.category, bucket.entries, bucket.images, results),
  }));
}

function edgeClassForStatus(status: PhaseStatus): string {
  if (status === 'running') return 'is-active';
  if (status === 'error') return 'is-error';
  if (status === 'incomplete') return 'is-attention';
  return 'is-settled';
}

export function buildExecutionFlowGraph(
  phases: readonly ExecutionPhase[],
  selectedPhaseId?: string | null,
): {
  nodes: ExecutionFlowNode[];
  edges: Edge[];
  bounds: Dimensions;
  lanes: number;
} {
  const nodes: ExecutionFlowNode[] = [];
  const edges: Edge[] = [];
  const maxLanes = Math.max(1, ...phases.map((p) => p.subBranches?.length ?? 1));
  const totalLaneHeight = maxLanes * FLOW_NODE_HEIGHT + (maxLanes - 1) * FLOW_GAP_Y;

  let cursorX = 0;
  let prevNodeIds: string[] = [];
  let prevStatus: PhaseStatus = 'done';

  phases.forEach((phase, phaseIndex) => {
    const hasImages = phase.images.length > 0;
    const nodeWidth = hasImages ? FLOW_NODE_IMAGE_WIDTH : FLOW_NODE_WIDTH;
    const hasPrev = phaseIndex > 0;
    const hasNext = phaseIndex < phases.length - 1;

    if (phase.subBranches && phase.subBranches.length >= 2) {
      const branches = phase.subBranches;
      const columnHeight = branches.length * FLOW_NODE_HEIGHT + (branches.length - 1) * FLOW_GAP_Y;
      const startY = (totalLaneHeight - columnHeight) / 2;
      const currentIds: string[] = [];

      branches.forEach((branch, branchIdx) => {
        const nodeId = `${phase.id}::${branch.id}`;
        currentIds.push(nodeId);
        nodes.push({
          id: nodeId,
          type: 'phaseNode',
          position: { x: cursorX, y: startY + branchIdx * (FLOW_NODE_HEIGHT + FLOW_GAP_Y) },
          width: FLOW_NODE_WIDTH,
          height: FLOW_NODE_HEIGHT,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            phase,
            stepLabel: `${phaseIndex + 1}.${branchIdx + 1}`,
            selected: selectedPhaseId === phase.id || selectedPhaseId === nodeId,
            branchIndex: branchIdx,
            branchTitle: branch.label,
            branchStatus: branch.status,
            hasPrev,
            hasNext,
          },
        });
        for (const sourceId of prevNodeIds) {
          edges.push({
            id: `${sourceId}->${nodeId}`,
            source: sourceId,
            target: nodeId,
            type: 'smoothstep',
            animated: branch.status === 'running' || prevStatus === 'running',
            className: `execution-flow-edge ${edgeClassForStatus(branch.status)}`,
            markerEnd: { type: MarkerType.ArrowClosed, width: 10, height: 10, color: 'var(--border-hover)' },
          });
        }
      });

      prevNodeIds = currentIds;
      prevStatus = phase.status;
      cursorX += FLOW_NODE_WIDTH + FLOW_GAP_X;
      return;
    }

    const y = (totalLaneHeight - FLOW_NODE_HEIGHT) / 2;
    nodes.push({
      id: phase.id,
      type: 'phaseNode',
      position: { x: cursorX, y },
      width: nodeWidth,
      height: FLOW_NODE_HEIGHT,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        phase,
        stepLabel: String(phaseIndex + 1),
        selected: selectedPhaseId === phase.id,
        hasPrev,
        hasNext,
      },
    });

    for (const sourceId of prevNodeIds) {
      edges.push({
        id: `${sourceId}->${phase.id}`,
        source: sourceId,
        target: phase.id,
        type: 'smoothstep',
        animated: phase.status === 'running' || prevStatus === 'running',
        className: `execution-flow-edge ${edgeClassForStatus(phase.status)}`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 10, height: 10, color: 'var(--border-hover)' },
      });
    }

    prevNodeIds = [phase.id];
    prevStatus = phase.status;
    cursorX += nodeWidth + FLOW_GAP_X;
  });

  const width = cursorX > 0 ? cursorX - FLOW_GAP_X : 0;
  return {
    nodes,
    edges,
    bounds: { width, height: totalLaneHeight },
    lanes: maxLanes,
  };
}
