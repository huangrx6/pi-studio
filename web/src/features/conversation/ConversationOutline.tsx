import type { OutlineItem } from './outline-model';

type ConversationOutlineProps = {
  items: OutlineItem[];
  samples: number[];
  activeIndex: number;
  hoverIndex: number | null;
  onHover: (index: number | null) => void;
  onJump: (index: number) => void;
};

export function ConversationOutline({
  items,
  samples,
  activeIndex,
  hoverIndex,
  onHover,
  onJump,
}: ConversationOutlineProps) {
  return (
    <nav className="conversation-outline" aria-label="对话大纲" onMouseLeave={() => onHover(null)}>
      <div className="outline-track">
        {samples.map((index) => {
          const item = items[index];
          return <div
            className={`outline-item ${hoverIndex === index ? 'is-hovered' : ''}`}
            key={item.sourceIndex}
            onMouseEnter={() => onHover(index)}
          >
            <button
              type="button"
              className={`outline-tick ${index === activeIndex ? 'is-active' : ''}`}
              aria-label={`跳转到第 ${index + 1} 条提问`}
              aria-current={index === activeIndex ? 'location' : undefined}
              title={item.text.slice(0, 100)}
              onFocus={() => onHover(index)}
              onClick={() => onJump(index)}
            ><span className="outline-line" /></button>
            {hoverIndex === index && <button
              type="button"
              className="outline-preview"
              tabIndex={-1}
              aria-label={`跳转到第 ${index + 1} 条提问：${item.text.slice(0, 100)}`}
              onClick={() => onJump(index)}
            >
              <span className="outline-preview-role">你 · {item.timestamp ? new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}<span>{index + 1} / {items.length}</span></span>
              <span className="outline-preview-text">{item.text}</span>
            </button>}
          </div>;
        })}
      </div>
    </nav>
  );
}
