import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BackgroundMedia } from '../shared/preferences';

type MediaProps = {
  media: BackgroundMedia;
  className: string;
  onError?: () => void;
};

function BackgroundImage({ media, className, onError }: MediaProps) {
  const [ready, setReady] = useState(false);
  return <img className={className} src={media.url} alt="" draggable={false} decoding="async"
    style={{ visibility: ready ? undefined : 'hidden' }}
    onLoad={async event => {
      const image = event.currentTarget;
      try { await image.decode(); } catch { /* A loaded image can still paint if predecoding is unavailable. */ }
      if (image.isConnected && image.complete && image.naturalWidth > 0) setReady(true);
    }}
    onError={onError} />;
}

export function BackgroundMediaNode({ media, className, onError }: MediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const syncPlayback = () => {
      if (document.visibilityState === 'hidden') {
        video.pause();
      } else {
        void video.play().catch(() => { /* Autoplay may be unavailable until the next user gesture. */ });
      }
    };
    syncPlayback();
    document.addEventListener('visibilitychange', syncPlayback);
    return () => document.removeEventListener('visibilitychange', syncPlayback);
  }, [media.url]);

  if (media.kind === 'video') {
    return (
      <video
        ref={videoRef}
        className={className}
        src={media.url}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        onError={onError}
      />
    );
  }
  return <BackgroundImage key={media.url} media={media} className={className} onError={onError} />;
}

export function BackgroundLayer({
  media,
  opacity,
  blur,
  scrim,
  onError,
}: {
  media: BackgroundMedia;
  opacity: number;
  blur: number;
  /** 壁纸遮罩强度 0–100：只压暗窗口外的壁纸，不影响窗口内表面。 */
  scrim: number;
  onError?: () => void;
}) {
  // 对外统一使用 0–100 的强度。40px 已能充分柔化照片，同时避免 100% 直接变成
  // 100px 后产生明显性能开销与图像边缘发虚。
  const blurPixels = Math.round(Math.min(100, Math.max(0, blur)) * 0.4);
  const style = {
    '--background-media-opacity': `${opacity}%`,
    '--background-media-blur': `${blurPixels}px`,
    '--background-media-scrim': `${Math.min(100, Math.max(0, scrim)) / 100}`,
  } as CSSProperties;

  return (
    <div className="background-layer" style={style} aria-hidden="true">
      <BackgroundMediaNode key={media.url} media={media} className="background-layer-media" onError={onError} />
      <div className="background-layer-soften" />
    </div>
  );
}

export function BackgroundMediaPreview({ media, onError }: { media: BackgroundMedia; onError?: () => void }) {
  return (
    <div className="background-media-preview">
      <BackgroundMediaNode key={media.url} media={media} className="background-media-preview-content" onError={onError} />
      <span className="background-media-preview-kind">{media.kind === 'video' ? '动态视频' : '图片背景'}</span>
    </div>
  );
}
