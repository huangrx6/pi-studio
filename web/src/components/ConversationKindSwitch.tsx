import { Clock3, MessageSquare } from 'lucide-react';
import type { ConversationKind } from '../types/durable-types';

/**
 * 新对话类型使用一个可移动滑块，避免把“对话 / 长期任务”混入输入区底部的
 * 上下文工具组。两个按钮保持相同的点击区域与键盘可达性。
 */
export function ConversationKindSwitch({
  value,
  onChange,
}: {
  value: ConversationKind;
  onChange: (value: ConversationKind) => void;
}) {
  return <div className={`conversation-kind-switch is-${value}`} role="group" aria-label="新对话类型">
    <span className="conversation-kind-thumb" aria-hidden="true" />
    <button
      type="button"
      className={value === 'conversation' ? 'is-active' : ''}
      aria-pressed={value === 'conversation'}
      onClick={() => onChange('conversation')}
    >
      <MessageSquare aria-hidden="true" />
      <span>对话</span>
    </button>
    <button
      type="button"
      className={value === 'durable' ? 'is-active' : ''}
      aria-pressed={value === 'durable'}
      onClick={() => onChange('durable')}
    >
      <Clock3 aria-hidden="true" />
      <span>长期任务</span>
    </button>
  </div>;
}
