import { useEffect, useRef, type CSSProperties } from 'react';
import type { BackgroundMedia } from '../lib/preferences';

type MediaProps = {
  media: BackgroundMedia;
  className: string;
  onError?: () => void;
};

function BackgroundMediaNode({ media, className, onError }: MediaProps) {
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
  return <img className={className} src={media.url} alt="" draggable={false} onError={onError} />;
}

export function BackgroundLayer({
  media,
  opacity,
  blur,
  onError,
}: {
  media: BackgroundMedia;
  opacity: number;
  blur: number;
  onError?: () => void;
}) {
  // 对外统一使用 0–100 的强度。40px 已能充分柔化照片，同时避免 100% 直接变成
  // 100px 后产生明显性能开销与图像边缘发虚。
  const blurPixels = Math.round(Math.min(100, Math.max(0, blur)) * 0.4);
  const style = {
    '--background-media-opacity': `${opacity}%`,
    '--background-media-blur': `${blurPixels}px`,
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
