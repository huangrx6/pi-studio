/**
 * 排队消息面板：智能体运行期间用户按 Cmd/Ctrl+Enter 时暂存的消息。
 *
 * 交互：
 * - 收起时只是一行摘要（图标 + 「排队消息」+ 条数），像计划胶囊；
 * - 点开后才出现逐条列表，顺序即发送顺序；
 * - 整行可拖拽，拖到另一行上即调整顺序；
 * - 每条悬停显示「立即插话发送 / 编辑并移回输入框 / 删除」；
 *   编辑后再次排队会保留原来的队列位置；
 * - 列表底部可把全部排队消息一次性插话发送。
 *
 * 本组件只负责渲染与事件上抛；真正的发送/队列状态在 App 中维护，最终通过
 * `piApi.conversationSubmit` 的 `steer` / `followUp` 行为写入 Durable。
 */
import { useState } from 'react';
import { ArrowUp, ChevronDown, Clock3, GripVertical, Pencil, Trash2 } from 'lucide-react';

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
  /** An automatic send was rejected; the row stays at this position. */
  error?: string;
  /** Durable admission is in flight; the row identity and content stay locked. */
  admissionPending?: boolean;
};

type QueuedMessagesProps = {
  /** While a turn is active the actions insert; while idle they start sending. */
  canSteer?: boolean;
  sendDisabled?: boolean;
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
 * 没有排队项时直接返回 null（此时才不占位）。默认收起：队列只是一条待办摘要，
 * 逐条内容与批处理操作都在展开之后才出现。
 */
export function QueuedMessages({ items, canSteer = false, sendDisabled = false, onEdit, onDelete, onSendNow, onSendAll, onReorder }: QueuedMessagesProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const sendAllLabel = canSteer ? '插话发送全部' : '发送全部';

  return <div className={`queued-panel${expanded ? ' is-expanded' : ''}`} aria-label="排队消息">
    <button type="button" className="queued-panel-head" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span className="queued-panel-title"><Clock3 />排队消息<b>{items.length}</b></span>
      <ChevronDown className={expanded ? 'is-flipped' : undefined} aria-hidden="true" />
    </button>
    {expanded && <div className="queued-body">
      <div className="queued-list">
        {items.map((item) => {
          const itemAdmissionPending = Boolean(item.admissionPending);
          const itemSendDisabled = sendDisabled || itemAdmissionPending;
          return <div
            className={`queued-item ${draggingId === item.id ? 'is-dragging' : ''} ${item.error ? 'is-error' : ''} ${item.admissionPending ? 'is-sending' : ''}`}
            key={item.id}
            // 用原生 HTML5 拖拽；把 id 写入 dataTransfer，drop 时读取，
            // 这样即使 drag 状态丢失也能确定来源（draggingId 只作兜底）。
            draggable={!itemAdmissionPending}
            aria-busy={item.admissionPending || undefined}
            onDragStart={(event) => { setDraggingId(item.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); }}
            onDragEnd={() => setDraggingId(null)}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
            onDrop={(event) => { event.preventDefault(); const fromId = event.dataTransfer.getData('text/plain') || draggingId; if (fromId && fromId !== item.id) onReorder(fromId, item.id); setDraggingId(null); }}
          >
            <span className="queued-grip" title="拖动调整顺序"><GripVertical /></span>
            <span className="queued-copy">
              <span className="queued-text">{item.text}</span>
              {item.admissionPending
                ? <span className="queued-state">正在确认消息是否已发送…</span>
                : item.error && <span className="queued-error">{item.error}</span>}
              {/* 附件计数用「图片 · 文件」组合，只有存在附件时才显示 */}
              {(item.images > 0 || item.files > 0) && <span className="queued-meta">{item.images > 0 ? `${item.images} 张图片` : ''}{item.images > 0 && item.files > 0 ? ' · ' : ''}{item.files > 0 ? `${item.files} 个文件` : ''}</span>}
            </span>
            <span className="queued-actions">
              <button type="button" disabled={itemSendDisabled} title={itemAdmissionPending ? '正在确认本条消息是否已发送' : canSteer ? '立即插话发送' : '立即发送'} aria-label={canSteer ? '立即插话发送' : '立即发送'} onClick={() => onSendNow(item.id)}><ArrowUp /></button>
              <button type="button" disabled={itemAdmissionPending} title={itemAdmissionPending ? '正在确认本条消息是否已发送' : '编辑；再次排队时放回原位置'} aria-label="编辑排队消息" onClick={() => onEdit(item.id)}><Pencil /></button>
              <button type="button" disabled={itemAdmissionPending} title={itemAdmissionPending ? '正在确认本条消息是否已发送' : '删除排队消息'} aria-label="删除排队消息" onClick={() => onDelete(item.id)}><Trash2 /></button>
            </span>
          </div>;
        })}
      </div>
      <div className="queued-footer">
        <button type="button" className="queued-send-all" disabled={sendDisabled} title={sendDisabled ? '当前会话暂时不能发送，排队消息已保留' : undefined} onClick={onSendAll}>{sendAllLabel}</button>
      </div>
    </div>}
  </div>;
}
