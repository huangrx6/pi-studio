import { useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import {
  ConversationImagePreview,
  type ConversationImage,
} from './ConversationImageGallery';
import {
  ImageContextMenu,
  imageContextMenuState,
  type ImageContextMenuState,
} from './ImageContextMenu';

/**
 * 输入框中的待发送图片。
 *
 * 预览与移除使用并列按钮，避免点击右上角删除时误触大图；同一输入框中的
 * 图片共享导航序列，因此任意一张打开后都可以用方向键或预览按钮切换。
 */
export function ComposerImageAttachment({
  images,
  index,
  onRemove,
}: {
  images: ConversationImage[];
  index: number;
  onRemove: () => void;
}) {
  const image = images[index];
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ImageContextMenuState | null>(null);

  if (!image) return null;

  return <>
    <div className="composer-attachment is-image">
      <button
        type="button"
        className="composer-image-preview-trigger"
        aria-label={`放大预览图片 ${index + 1}${image.alt ? `：${image.alt}` : ''}`}
        title="点击放大预览"
        onClick={() => setActiveIndex(index)}
        onContextMenu={(event) => setContextMenu(imageContextMenuState(event, image))}
      >
        <img src={image.src} alt={image.alt || ''} draggable={false} />
        <span className="composer-image-preview-cue" aria-hidden="true"><Maximize2 /></span>
      </button>
      <button
        type="button"
        className="composer-attachment-remove"
        aria-label={`移除 ${image.alt || `图片 ${index + 1}`}`}
        title="移除"
        onClick={onRemove}
      ><X /></button>
    </div>
    {activeIndex !== null && <ConversationImagePreview
      images={images}
      index={activeIndex}
      onClose={() => setActiveIndex(null)}
      onIndexChange={setActiveIndex}
    />}
    {contextMenu && <ImageContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />}
  </>;
}
