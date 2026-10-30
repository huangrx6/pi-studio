import type { MouseEvent as ReactMouseEvent } from 'react';
import { ActionMenu } from './ActionMenu';

export type ImageCopyTarget = {
  src: string;
  alt?: string;
};

export type ImageContextMenuState = ImageCopyTarget & {
  x: number;
  y: number;
};

export function imageContextMenuState(
  event: ReactMouseEvent,
  image: ImageCopyTarget,
): ImageContextMenuState {
  event.preventDefault();
  event.stopPropagation();
  return imageContextMenuPoint(event.clientX, event.clientY, image);
}

export function imageContextMenuPoint(
  x: number,
  y: number,
  image: ImageCopyTarget,
): ImageContextMenuState {
  return { ...image, x, y };
}

export function ImageContextMenu({
  menu,
  onClose,
}: {
  menu: ImageContextMenuState;
  onClose: () => void;
}) {
  return <ActionMenu
    x={menu.x}
    y={menu.y}
    onClose={onClose}
    items={[{
      label: '复制图片',
      run: () => {
        void window.piApi.copyImage({ src: menu.src }).catch((copyError) => {
          window.dispatchEvent(new CustomEvent('pi-studio:notify', {
            detail: {
              tone: 'error',
              title: '复制图片失败',
              message: copyError instanceof Error ? copyError.message : String(copyError),
            },
          }));
        });
      },
    }]}
  />;
}
