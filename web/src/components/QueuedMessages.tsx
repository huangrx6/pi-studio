/**
 * 排队消息面板：智能体运行期间用户按 Cmd/Ctrl+Enter 时暂存的消息。
 *
 * 交互：
 * - 列表顺序即发送顺序；
 * - 整行可拖拽，拖到另一行上即调整顺序；
 * - 每条可「立即插话发送」「编辑并移回输入框」「删除」；
 *   编辑后再次排队会保留原来的队列位置；
 * - 顶部可把全部排队消息一次性插话发送。
 *
 * 本组件只负责渲染与事件上抛；真正的发送/队列状态在 App 中维护，最终通过
 * `piApi.conversationSubmit` 的 `steer` / `followUp` 行为写入 Durable。
 */
import { useState } from 'react';
import { ArrowUp, Clock3, GripVertical, Pencil, Trash2 } from 'lucide-react';

/** 排队项用于展示的精简信息（正文 + 附件计数）。 */
export type QueuedPreview = {
  /** 队列项唯一 id。 */
  id: string;
  /** 预览文本；无正文时 App 会填「图片消息」/「附件消息」。 */
  text: string;
  /** 图片附件数量。 */
  images: number;
  /** 普通文件数量。 */
  files: number;
};

type QueuedMessagesProps = {
  /** 当前排队项，顺序即发送顺序。 */
  items: QueuedPreview[];
  /** 编辑：App 会把它移出队列并放回输入框。 */
  onEdit: (id: string) => void;
  /** 删除排队项。 */
  onDelete: (id: string) => void;
  /** 立即把该条作为插话发送（steer）。 */
  onSendNow: (id: string) => void;
  /** 全部插话发送。 */
  onSendAll: () => void;
  /** 拖拽排序：把 fromId 移动到 toId 的位置。 */
  onReorder: (fromId: string, toId: string) => void;
};

/**
 * 排队消息面板。
 *
 * @param items 排队项列表
 * @param onEdit / onDelete / onSendNow / onSendAll / onReorder 由 App 提供的动作回调
 *
 * 没有排队项时直接返回 null（此时才不占位）；
 * draggingId 仅用于给正在拖动的行加高亮，不参与排序计算。
 */
export function QueuedMessages({ items, onEdit, onDelete, onSendNow, onSendAll, onReorder }: QueuedMessagesProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  if (items.length === 0) return null;
  return <div className="queued-panel" aria-label="排队消息">
    <div className="queued-panel-head">
      <span className="queued-panel-title"><Clock3 />排队消息<b>{items.length}</b></span>
      <button type="button" className="queued-send-all" onClick={onSendAll}>插话发送全部</button>
    </div>
    <div className="queued-list">
      {items.map((item) => <div
        className={`queued-item ${draggingId === item.id ? 'is-dragging' : ''}`}
        key={item.id}
        // 用原生 HTML5 拖拽；把 id 写入 dataTransfer，drop 时读取，
        // 这样即使 drag 状态丢失也能确定来源（draggingId 只作兜底）。
        draggable
        onDragStart={(event) => { setDraggingId(item.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); }}
        onDragEnd={() => setDraggingId(null)}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
        onDrop={(event) => { event.preventDefault(); const fromId = event.dataTransfer.getData('text/plain') || draggingId; if (fromId && fromId !== item.id) onReorder(fromId, item.id); setDraggingId(null); }}
      >
        <span className="queued-grip" title="拖动调整顺序"><GripVertical /></span>
        <span className="queued-copy">
          <span className="queued-text">{item.text}</span>
          {/* 附件计数用「图片 · 文件」组合，只有存在附件时才显示 */}
          {(item.images > 0 || item.files > 0) && <span className="queued-meta">{item.images > 0 ? `${item.images} 张图片` : ''}{item.images > 0 && item.files > 0 ? ' · ' : ''}{item.files > 0 ? `${item.files} 个文件` : ''}</span>}
        </span>
        <span className="queued-actions">
          <button type="button" title="立即插话发送" aria-label="立即插话发送" onClick={() => onSendNow(item.id)}><ArrowUp /></button>
          <button type="button" title="编辑；再次排队时放回原位置" aria-label="编辑排队消息" onClick={() => onEdit(item.id)}><Pencil /></button>
          <button type="button" title="删除排队消息" aria-label="删除排队消息" onClick={() => onDelete(item.id)}><Trash2 /></button>
        </span>
      </div>)}
    </div>
  </div>;
}
