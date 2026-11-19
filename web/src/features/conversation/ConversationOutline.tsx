import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { OutlineItem } from './outline-model';
import {
  OUTLINE_ROW_HEIGHT,
  OUTLINE_VIRTUAL_THRESHOLD,
  visibleOutlineRange,
} from './outline-virtualization';

type ConversationOutlineProps = {
  items: OutlineItem[];
  samples: number[];
  activeIndex: number;
  onJump: (index: number) => void;
};

type HoverBox = { index: number; top: number };

/**
 * Session outline ticks. Hover stays local so moving the pointer does not
 * rebuild the transcript tree. Long histories virtualize the track.
 */
function ConversationOutlineComponent({
  items,
  samples,
  activeIndex,
  onJump,
}: ConversationOutlineProps) {
  const nav = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<HoverBox | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [range, setRange] = useState({ start: 0, end: samples.length });
  const virtual = samples.length > OUTLINE_VIRTUAL_THRESHOLD;

  const syncRange = useCallback(() => {
    const host = track.current;
    if (!host) return;
    if (!virtual) {
      setRange({ start: 0, end: samples.length });
      return;
    }
    const next = visibleOutlineRange(samples.length, host.scrollTop, host.clientHeight);
    setRange((current) => (
      current.start === next.start && current.end === next.end ? current : next
    ));
  }, [samples.length, virtual]);

  useEffect(() => {
    syncRange();
  }, [syncRange, samples.length]);

  useEffect(() => {
    const host = track.current;
    if (!host || activeIndex < 0) return;
    // Dense samples are identity indexes; avoid a linear scan on every active change.
    const samplePos = samples.length === items.length && samples[activeIndex] === activeIndex
      ? activeIndex
      : samples.indexOf(activeIndex);
    if (samplePos < 0) return;

    if (virtual) {
      const top = samplePos * OUTLINE_ROW_HEIGHT;
      const bottom = top + OUTLINE_ROW_HEIGHT;
      const viewTop = host.scrollTop;
      const viewBottom = viewTop + host.clientHeight;
      const inset = Math.max(18, Math.round(host.clientHeight * 0.28));
      if (top < viewTop + inset) host.scrollTop = Math.max(0, top - inset);
      else if (bottom > viewBottom - inset) {
        host.scrollTop = Math.min(host.scrollHeight - host.clientHeight, bottom - host.clientHeight + inset);
      }
      syncRange();
      return;
    }

    const child = host.children[samplePos] as HTMLElement | undefined;
    if (!child) return;
    const top = child.offsetTop;
    const bottom = top + child.offsetHeight;
    const viewTop = host.scrollTop;
    const viewBottom = viewTop + host.clientHeight;
    const inset = Math.max(18, Math.round(host.clientHeight * 0.28));
    if (top < viewTop + inset) host.scrollTop = Math.max(0, top - inset);
    else if (bottom > viewBottom - inset) {
      host.scrollTop = Math.min(host.scrollHeight - host.clientHeight, bottom - host.clientHeight + inset);
    }
  }, [activeIndex, items.length, samples, syncRange, virtual]);

  function showPreview(index: number, node: HTMLElement) {
    const tick = node.getBoundingClientRect();
    const host = nav.current?.getBoundingClientRect();
    setBox({ index, top: tick.top - (host?.top ?? 0) + tick.height / 2 });
    setHoverIndex(index);
  }

  function hidePreview() {
    setBox(null);
    setHoverIndex(null);
  }

  const hovered = box ? items[box.index] : null;
  const start = range.start;
  const end = range.end;
  const topSpacer = virtual ? start * OUTLINE_ROW_HEIGHT : 0;
  const bottomSpacer = virtual ? Math.max(0, samples.length - end) * OUTLINE_ROW_HEIGHT : 0;

  return <nav ref={nav} className="conversation-outline" aria-label="对话大纲" onMouseLeave={hidePreview}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) hidePreview(); }}>
    <div
      ref={track}
      className={`outline-track${virtual ? ' is-virtualized' : ''}`}
      onScroll={virtual ? () => { syncRange(); } : undefined}
    >
      {topSpacer > 0 && <div className="outline-spacer" style={{ height: topSpacer }} aria-hidden="true" />}
      {samples.slice(start, end).map((index, offset) => {
        const item = items[index];
        if (!item) return null;
        const samplePos = start + offset;
        return <div
          className={`outline-item${hoverIndex === index ? ' is-hovered' : ''}`}
          key={item.sourceIndex}
          data-sample-pos={samplePos}
          onMouseEnter={(event) => showPreview(index, event.currentTarget)}
        >
          <button
            type="button"
            className={`outline-tick${index === activeIndex ? ' is-active' : ''}`}
            aria-label={`跳转到第 ${index + 1} 条提问`}
            aria-current={index === activeIndex ? 'location' : undefined}
            onFocus={(event) => showPreview(index, event.currentTarget)}
            onClick={() => onJump(index)}
          ><span className="outline-line" /></button>
        </div>;
      })}
      {bottomSpacer > 0 && <div className="outline-spacer" style={{ height: bottomSpacer }} aria-hidden="true" />}
    </div>
    {hovered && box && <button
      type="button"
      className="outline-preview"
      tabIndex={-1}
      style={{ top: box.top }}
      aria-label={`跳转到第 ${box.index + 1} 条提问：${hovered.text.slice(0, 100)}`}
      onClick={() => onJump(box.index)}
    >
      <span className="outline-preview-role">你 · {hovered.timestamp ? new Date(hovered.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}<span>{box.index + 1} / {items.length}</span></span>
      <span className="outline-preview-text">{hovered.text}</span>
    </button>}
  </nav>;
}

export const ConversationOutline = memo(ConversationOutlineComponent);
