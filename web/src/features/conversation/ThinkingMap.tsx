import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
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
import type { ChatMessage } from '../../types/chat-types';
import {
  buildThinkingMap,
  type ThinkingMapNode,
  type ThinkingMapNodeKind,
  type ThinkingMapNodeStatus,
} from './thinking-map-model.ts';
import type { ActivityEntry } from './turn-content.ts';
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

function NodeCard({
  node,
  index,
  open,
  onToggle,
}: {
  node: ThinkingMapNode;
  index: number;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = kindIcon[node.kind] || Wrench;
  const hasBody = Boolean(node.detail.trim());
  return (
    <li
      className={`thinking-map-node is-${node.kind} is-${node.status}${open ? ' is-open' : ''}${node.live ? ' is-live' : ''}`}
      style={{ ['--map-index' as string]: String(index) }}
    >
      <div className="thinking-map-rail" aria-hidden="true">
        <span className="thinking-map-dot"><Icon /></span>
      </div>
      <div className="thinking-map-card">
        <button
          type="button"
          className="thinking-map-card-head"
          aria-expanded={open}
          disabled={!hasBody}
          onClick={() => hasBody && onToggle()}
        >
          <div className="thinking-map-card-copy">
            <strong>{node.title}</strong>
            {node.preview && <span>{node.preview}</span>}
          </div>
          <span className={`thinking-map-badge is-${node.status}`}>
            <StatusGlyph status={node.status} />
            {statusLabel(node.status)}
          </span>
          {hasBody && <ChevronDown className="thinking-map-chevron" aria-hidden="true" />}
        </button>
        {open && hasBody && (
          <div className="thinking-map-card-body">
            {node.kind === 'thinking'
              ? <div className="thinking-map-prose">{node.detail}</div>
              : <pre>{node.detail}</pre>}
          </div>
        )}
      </div>
    </li>
  );
}

export function ThinkingMap({
  entries,
  results,
  live = false,
}: {
  entries: ActivityEntry[];
  results: Map<string, ChatMessage>;
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const model = useMemo(() => buildThinkingMap(entries, results), [entries, results]);

  useEffect(() => {
    if (!open) return;
    // Auto-expand the live tail so the map feels "alive" while work continues.
    const liveNode = [...model.nodes].reverse().find((node) => node.live || node.status === 'running');
    if (!liveNode) return;
    setExpanded((current) => (current.has(liveNode.id) ? current : new Set(current).add(liveNode.id)));
  }, [open, model.nodes]);

  if (model.nodes.length === 0) return null;

  const label = live
    ? `思维链路（进行中 · ${model.stats.total} 步）`
    : `思维链路（${model.stats.total} 步）`;

  function toggleNode(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function expandThoughts() {
    setExpanded(new Set(model.nodes.filter((node) => node.kind === 'thinking' && node.detail).map((node) => node.id)));
  }

  function collapseAll() {
    setExpanded(new Set());
  }

  return <>
    <button
      type="button"
      className={`message-action thinking-map-trigger${live ? ' is-live' : ''}`}
      aria-haspopup="dialog"
      aria-label={label}
      title={label}
      onClick={() => setOpen(true)}
    >
      <Waypoints aria-hidden="true" />
    </button>
    {open && (
      <DetailDialog className="thinking-map-dialog" onClose={() => setOpen(false)}>
        <header className="thinking-map-header">
          <span className="thinking-map-emblem" aria-hidden="true">
            <BrainCircuit />
          </span>
          <div>
            <h2>思维链路</h2>
            <p>
              {[
                model.stats.thinking > 0 && `${model.stats.thinking} 次思考`,
                model.stats.tools > 0 && `${model.stats.tools} 次工具`,
                model.stats.errors > 0 && `${model.stats.errors} 步失败`,
                model.stats.running > 0 && `${model.stats.running} 步进行中`,
              ].filter(Boolean).join(' · ') || `${model.stats.total} 个步骤`}
            </p>
          </div>
          <div className="thinking-map-header-actions">
            <button type="button" className="text-button" onClick={expandThoughts}>展开思考</button>
            <button type="button" className="text-button" onClick={collapseAll}>全部收起</button>
            <button type="button" className="icon-button" aria-label="关闭思维链路" onClick={() => setOpen(false)}>
              <X />
            </button>
          </div>
        </header>
        <div className="thinking-map-body">
          <ol className="thinking-map-flow">
            {model.nodes.map((node, index) => (
              <NodeCard
                key={node.id}
                node={node}
                index={index}
                open={expanded.has(node.id)}
                onToggle={() => toggleNode(node.id)}
              />
            ))}
          </ol>
          {model.nodes.length === 0 && (
            <p className="thinking-map-empty">这一轮还没有可展示的思考或执行步骤。</p>
          )}
        </div>
      </DetailDialog>
    )}
  </>;
}
