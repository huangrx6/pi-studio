/**
 * 会话图片画廊：固定尺寸的横向缩略图带与大图预览。
 *
 * 图片块来自 Durable 消息内容，可能是用户附件、工具结果或子 Harness 输出。
 * 缩略图保持相同盒子尺寸并用 contain 完整显示；数量增加时只扩展横向滚动，
 * 不换行撑高对话。预览支持点击遮罩、Esc、左右方向键和焦点返回。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Maximize2, X } from 'lucide-react';

export type ConversationImage = {
  src: string;
  alt?: string;
};

export function ConversationImagePreview({ images, index, returnFocus, onClose, onIndexChange }: {
  images: ConversationImage[];
  index: number;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const activeImage = images[index];
  const previewOpen = Boolean(activeImage);

  function closePreview() {
    onClose();
    window.requestAnimationFrame(() => returnFocus?.focus());
  }

  function stepPreview(direction: -1 | 1) {
    if (images.length > 1) onIndexChange((index + direction + images.length) % images.length);
  }

  useEffect(() => {
    if (!previewOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [previewOpen]);

  useEffect(() => {
    if (!previewOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePreview();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepPreview(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        stepPreview(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewOpen, images.length, index]);

  if (!activeImage) return null;
  return createPortal(
    <div
      className="conversation-image-preview"
      role="dialog"
      aria-modal="true"
      aria-label={`查看第 ${index + 1} 张图片，共 ${images.length} 张`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePreview();
      }}
    >
      <div className="conversation-image-preview-frame">
        <div className="conversation-image-preview-topbar">
          <span aria-live="polite">{index + 1} / {images.length}</span>
          <button ref={closeButtonRef} type="button" aria-label="关闭图片预览" title="关闭" onClick={closePreview}>
            <X />
          </button>
        </div>
        <img src={activeImage.src} alt={activeImage.alt || `图片 ${index + 1}`} draggable={false} />
        {images.length > 1 && <>
          <button
            type="button"
            className="conversation-image-preview-nav is-previous"
            aria-label="查看上一张图片"
            title="上一张"
            onClick={() => stepPreview(-1)}
          ><ChevronLeft /></button>
          <button
            type="button"
            className="conversation-image-preview-nav is-next"
            aria-label="查看下一张图片"
            title="下一张"
            onClick={() => stepPreview(1)}
          ><ChevronRight /></button>
        </>}
        {activeImage.alt && <div className="conversation-image-preview-caption">{activeImage.alt}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConversationImageGallery({ images, className = '' }: {
  images: ConversationImage[];
  className?: string;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  function openPreview(index: number, trigger: HTMLElement) {
    returnFocusRef.current = trigger;
    setActiveIndex(index);
  }

  function closePreview() {
    setActiveIndex(null);
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  }

  if (images.length === 0) return null;

  return <div className={`conversation-image-gallery ${className}`.trim()}>
    <div
      className="conversation-image-strip"
      role="group"
      aria-label={`${images.length} 张图片`}
      tabIndex={images.length > 1 ? 0 : undefined}
    >
      {images.map((image, index) => <button
        key={`${index}-${image.src.slice(-32)}`}
        type="button"
        className="conversation-image-tile"
        aria-label={`放大预览图片 ${index + 1}${image.alt ? `：${image.alt}` : ''}`}
        title="点击放大预览"
        onClick={(event) => openPreview(index, event.currentTarget)}
      >
        <img src={image.src} alt={image.alt || ''} loading="lazy" decoding="async" draggable={false} />
        {images.length > 1 && <span className="conversation-image-index" aria-hidden="true">{index + 1}</span>}
        <span className="conversation-image-expand" aria-hidden="true"><Maximize2 /></span>
      </button>)}
    </div>

    {activeIndex !== null && <ConversationImagePreview
      images={images}
      index={activeIndex}
      returnFocus={returnFocusRef.current}
      onClose={closePreview}
      onIndexChange={setActiveIndex}
    />}
  </div>;
}
