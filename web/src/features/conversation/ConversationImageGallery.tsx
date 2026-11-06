/**
 * 会话图片画廊：固定尺寸的横向缩略图带与全功能大图预览。
 *
 * 图片块来自 Durable 消息内容，可能是用户附件、工具结果或子 Harness 输出。
 * 缩略图保持相同盒子尺寸并用 contain 完整显示；数量增加时只扩展横向滚动，
 * 不换行撑高对话。大图预览按需加载独立 lightbox，提供缩放、拖拽、全屏、
 * 下载、缩略图导航和键盘操作，视觉仍由 Studio 的主题变量控制。
 */
import { lazy, Suspense, useState } from 'react';
import {
  LoaderCircle,
  Maximize2,
} from 'lucide-react';
import {
  ImageContextMenu,
  imageContextMenuState,
  type ImageContextMenuState,
} from '../../shared/ImageContextMenu';

export type ConversationImage = {
  src: string;
  alt?: string;
};

const loadImagePreview = () => import('./ConversationImagePreview');
const LazyConversationImagePreview = lazy(async () => {
  const module = await loadImagePreview();
  return { default: module.ConversationImagePreview };
});

function ImagePreviewFallback() {
  return <div className="image-preview-loading" role="status" aria-label="正在打开图片预览">
    <LoaderCircle className="spin" aria-hidden="true" />
  </div>;
}

export function ConversationImagePreview(props: Parameters<typeof LazyConversationImagePreview>[0]) {
  return <Suspense fallback={<ImagePreviewFallback />}>
    <LazyConversationImagePreview {...props} />
  </Suspense>;
}

export function ConversationImageGallery({ images, className = '' }: {
  images: ConversationImage[];
  className?: string;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ImageContextMenuState | null>(null);

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
        onFocus={() => { void loadImagePreview(); }}
        onPointerEnter={() => { void loadImagePreview(); }}
        onClick={() => setActiveIndex(index)}
        onContextMenu={(event) => setContextMenu(imageContextMenuState(event, image))}
      >
        <img src={image.src} alt={image.alt || ''} loading="lazy" decoding="async" draggable={false} />
        {images.length > 1 && <span className="conversation-image-index" aria-hidden="true">{index + 1}</span>}
        <span className="conversation-image-expand" aria-hidden="true"><Maximize2 /></span>
      </button>)}
    </div>

    {activeIndex !== null && <ConversationImagePreview
      images={images}
      index={activeIndex}
      onClose={() => setActiveIndex(null)}
      onIndexChange={setActiveIndex}
    />}
    {contextMenu && <ImageContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />}
  </div>;
}
