/**
 * 会话图片画廊：固定尺寸的横向缩略图带与全功能大图预览。
 *
 * 图片块来自 Durable 消息内容，可能是用户附件、工具结果或子 Harness 输出。
 * 缩略图保持相同盒子尺寸并用 contain 完整显示；数量增加时只扩展横向滚动，
 * 不换行撑高对话。大图预览使用独立 lightbox，提供缩放、拖拽、全屏、下载、
 * 缩略图导航和键盘操作，视觉仍由 Studio 的主题变量控制。
 */
import { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Images,
  Maximize2,
  Minimize2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import Lightbox from 'yet-another-react-lightbox';
import Captions from 'yet-another-react-lightbox/plugins/captions';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import DownloadPlugin from 'yet-another-react-lightbox/plugins/download';
import Fullscreen from 'yet-another-react-lightbox/plugins/fullscreen';
import Thumbnails from 'yet-another-react-lightbox/plugins/thumbnails';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';

export type ConversationImage = {
  src: string;
  alt?: string;
};

function imageExtension(src: string): string {
  const mime = src.match(/^data:image\/([^;,]+)/i)?.[1]?.toLowerCase();
  if (mime === 'jpeg') return 'jpg';
  if (mime === 'svg+xml') return 'svg';
  if (mime && /^[a-z0-9]+$/.test(mime)) return mime;
  const pathname = src.match(/^[a-z]+:\/\/[^/]+(\/[^?#]+)/i)?.[1] || src;
  return pathname.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1]?.toLowerCase() || 'png';
}

export function ConversationImagePreview({ images, index, onClose, onIndexChange }: {
  images: ConversationImage[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  const activeImage = images[index];
  if (!activeImage) return null;
  const hasMultipleImages = images.length > 1;
  const slides = images.map((image, imageIndex) => ({
    src: image.src,
    alt: image.alt || `图片 ${imageIndex + 1}`,
    thumbnail: image.src,
    title: image.alt || undefined,
    description: images.length > 1 ? `第 ${imageIndex + 1} 张，共 ${images.length} 张` : undefined,
    download: {
      url: image.src,
      filename: `pi-studio-image-${String(imageIndex + 1).padStart(2, '0')}.${imageExtension(image.src)}`,
    },
  }));
  return <Lightbox
    open
    close={onClose}
    index={index}
    slides={slides}
    plugins={hasMultipleImages
      ? [Zoom, Thumbnails, Captions, DownloadPlugin, Fullscreen, Counter]
      : [Zoom, Captions, DownloadPlugin, Fullscreen]}
    className="studio-lightbox"
    toolbar={{ buttons: hasMultipleImages
      ? ['download', 'fullscreen', 'zoom', 'thumbnails', 'close']
      : ['download', 'fullscreen', 'zoom', 'close'] }}
    thumbnails={{
      position: 'bottom',
      width: 76,
      height: 52,
      border: 1,
      borderRadius: 8,
      padding: 2,
      gap: 8,
      showToggle: true,
      vignette: false,
    }}
    captions={{ showToggle: false, descriptionTextAlign: 'center', descriptionMaxLines: 2 }}
    zoom={{ maxZoomPixelRatio: 2.5, zoomInMultiplier: 1.75, wheelZoomDistanceFactor: 80 }}
    carousel={{ finite: false, padding: 56, preload: 2 }}
    animation={{ fade: 180, swipe: 240, navigation: 180, zoom: 200 }}
    controller={{ closeOnBackdropClick: true, closeOnPullDown: true, closeOnPullUp: true, closeOnEscape: true }}
    labels={{
      Lightbox: '图片预览',
      Carousel: '图片预览',
      Slide: '图片',
      Previous: '上一张',
      Next: '下一张',
      Close: '关闭图片预览',
      Download: '下载图片',
      'Enter Fullscreen': '进入全屏',
      'Exit Fullscreen': '退出全屏',
      'Zoom in': '放大',
      'Zoom out': '缩小',
      Thumbnails: '图片缩略图',
      'Show thumbnails': '显示缩略图',
      'Hide thumbnails': '隐藏缩略图',
      '{index} of {total}': '第 {index} 张，共 {total} 张',
    }}
    render={{
      iconPrev: () => <ChevronLeft className="yarl__icon" />,
      iconNext: () => <ChevronRight className="yarl__icon" />,
      iconClose: () => <X className="yarl__icon" />,
      iconDownload: () => <Download className="yarl__icon" />,
      iconEnterFullscreen: () => <Maximize2 className="yarl__icon" />,
      iconExitFullscreen: () => <Minimize2 className="yarl__icon" />,
      iconZoomIn: () => <ZoomIn className="yarl__icon" />,
      iconZoomOut: () => <ZoomOut className="yarl__icon" />,
      iconThumbnailsVisible: () => <Images className="yarl__icon" />,
      iconThumbnailsHidden: () => <Images className="yarl__icon" />,
      buttonPrev: hasMultipleImages ? undefined : () => null,
      buttonNext: hasMultipleImages ? undefined : () => null,
      controls: () => <div className="studio-lightbox-hint" aria-hidden="true">
        <span>拖动查看</span>
        <i />
        <span>双击或 ± 缩放</span>
        {hasMultipleImages && <>
          <i />
          <span>← → 切换</span>
        </>}
      </div>,
    }}
    on={{ view: ({ index: nextIndex }) => onIndexChange(nextIndex) }}
  />;
}

export function ConversationImageGallery({ images, className = '' }: {
  images: ConversationImage[];
  className?: string;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

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
        onClick={() => setActiveIndex(index)}
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
  </div>;
}
