import { useEffect, useRef, useState } from 'react';
import type { OutlineItem } from './outline-model';

type ConversationOutlineProps = {
  items: OutlineItem[];
  samples: number[];
  activeIndex: number;
  hoverIndex: number | null;
  onHover: (index: number | null) => void;
  onJump: (index: number) => void;
};

type HoverBox = { index: number; top: number; left: number };

/**
 * 会话缩略导航：每一次提问一个刻度，放在标题与菜单栏同一条左缘上。
 *
 * 刻度全量渲染，超出最大高度时在轨道内滚动（不显示滚动条，上下渐隐）。
 * 悬停卡片用 fixed 定位，避免被滚动容器裁掉。
 */
export function ConversationOutline({
  items,
  samples,
  activeIndex,
  hoverIndex,
  onHover,
  onJump,
}: ConversationOutlineProps) {
  const nav = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<HoverBox | null>(null);

  useEffect(() => {
    const host = track.current;
    if (!host || activeIndex < 0) return;
    const child = host.children[samples.indexOf(activeIndex)] as HTMLElement | undefined;
    if (!child) return;
    // Keep the active tick in a small reading window without using
    // scrollIntoView, which could also scroll the outer app shell.
    const top = child.offsetTop;
    const bottom = top + child.offsetHeight;
    const viewTop = host.scrollTop;
    const viewBottom = viewTop + host.clientHeight;
    const inset = Math.max(18, Math.round(host.clientHeight * 0.28));
    if (top < viewTop + inset) {
      host.scrollTop = Math.max(0, top - inset);
    } else if (bottom > viewBottom - inset) {
      host.scrollTop = Math.min(host.scrollHeight - host.clientHeight, bottom - host.clientHeight + inset);
    }
  }, [activeIndex, samples]);

  function showPreview(index: number, node: HTMLElement) {
    const tick = node.getBoundingClientRect();
    const host = nav.current?.getBoundingClientRect();
    // 相对 nav 定位（nav 自带 transform，fixed 会以它为包含块）。
    setBox({ index, top: tick.top - (host?.top ?? 0) + tick.height / 2, left: 52 });
    onHover(index);
  }

  function hidePreview() {
    setBox(null);
    onHover(null);
  }

  const hovered = box ? items[box.index] : null;

  return <nav ref={nav} className="conversation-outline" aria-label="对话大纲" onMouseLeave={hidePreview}>
    <div ref={track} className="outline-track">
      {samples.map((index) => {
        const item = items[index];
        if (!item) return null;
        return <div
          className={`outline-item ${hoverIndex === index ? 'is-hovered' : ''}`}
          key={item.sourceIndex}
          onMouseEnter={(event) => showPreview(index, event.currentTarget)}
        >
          <button
            type="button"
            className={`outline-tick ${index === activeIndex ? 'is-active' : ''}`}
            aria-label={`跳转到第 ${index + 1} 条提问`}
            aria-current={index === activeIndex ? 'location' : undefined}
            onFocus={(event) => showPreview(index, event.currentTarget)}
            onBlur={hidePreview}
            onClick={() => onJump(index)}
          ><span className="outline-line" /></button>
        </div>;
      })}
    </div>
    {hovered && box && <button
      type="button"
      className="outline-preview"
      tabIndex={-1}
      style={{ top: box.top, left: box.left }}
      aria-label={`跳转到第 ${box.index + 1} 条提问：${hovered.text.slice(0, 100)}`}
      onClick={() => onJump(box.index)}
    >
      <span className="outline-preview-role">你 · {hovered.timestamp ? new Date(hovered.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}<span>{box.index + 1} / {items.length}</span></span>
      <span className="outline-preview-text">{hovered.text}</span>
    </button>}
  </nav>;
}
