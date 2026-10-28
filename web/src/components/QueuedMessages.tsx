import { useState } from 'react';
import { ArrowUp, Clock3, GripVertical, Pencil, Trash2 } from 'lucide-react';

export type QueuedPreview = {
  id: string;
  text: string;
  images: number;
  files: number;
};

type QueuedMessagesProps = {
  items: QueuedPreview[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onSendNow: (id: string) => void;
  onSendAll: () => void;
  onReorder: (fromId: string, toId: string) => void;
};

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
        draggable
        onDragStart={(event) => { setDraggingId(item.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); }}
        onDragEnd={() => setDraggingId(null)}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
        onDrop={(event) => { event.preventDefault(); const fromId = event.dataTransfer.getData('text/plain') || draggingId; if (fromId && fromId !== item.id) onReorder(fromId, item.id); setDraggingId(null); }}
      >
        <span className="queued-grip" title="拖动调整顺序"><GripVertical /></span>
        <span className="queued-copy">
          <span className="queued-text">{item.text}</span>
          {(item.images > 0 || item.files > 0) && <span className="queued-meta">{item.images > 0 ? `${item.images} 张图片` : ''}{item.images > 0 && item.files > 0 ? ' · ' : ''}{item.files > 0 ? `${item.files} 个文件` : ''}</span>}
        </span>
        <span className="queued-actions">
          <button type="button" title="立即插话发送" aria-label="立即插话发送" onClick={() => onSendNow(item.id)}><ArrowUp /></button>
          <button type="button" title="编辑并移回输入框" aria-label="编辑排队消息" onClick={() => onEdit(item.id)}><Pencil /></button>
          <button type="button" title="删除排队消息" aria-label="删除排队消息" onClick={() => onDelete(item.id)}><Trash2 /></button>
        </span>
      </div>)}
    </div>
  </div>;
}
