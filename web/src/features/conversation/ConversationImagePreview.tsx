/**
 * Full-screen image preview loaded only after the user opens an image.
 *
 * Keeping the Lightbox engine and its plugin CSS out of the conversation entry
 * avoids parsing and styling an interaction that most sessions never use.
 */
import { useEffect, useState } from 'react';
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
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/captions.css';
import 'yet-another-react-lightbox/plugins/counter.css';
import 'yet-another-react-lightbox/plugins/thumbnails.css';
import {
  ImageContextMenu,
  imageContextMenuPoint,
  type ImageContextMenuState,
} from '../../shared/ImageContextMenu';
import type { ConversationImage } from './ConversationImageGallery';

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
  const [contextMenu, setContextMenu] = useState<ImageContextMenuState | null>(null);
  useEffect(() => {
    if (!activeImage) return;
    const handleContextMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.yarl__slide_image')) return;
      event.preventDefault();
      event.stopPropagation();
      setContextMenu(imageContextMenuPoint(event.clientX, event.clientY, activeImage));
    };
    document.addEventListener('contextmenu', handleContextMenu, true);
    return () => document.removeEventListener('contextmenu', handleContextMenu, true);
  }, [activeImage]);
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
  return <>
    <Lightbox
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
    />
    {contextMenu && <ImageContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />}
  </>;
}
