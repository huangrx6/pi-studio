import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BackgroundMedia } from '../shared/preferences';

type MediaProps = {
  media: BackgroundMedia;
  className: string;
  onReady?: (url: string) => void;
  onError?: () => void;
  /** Capture one video frame instead of looping — used for the outer layer when the inside also plays. */
  still?: boolean;
};

function BackgroundImage({ media, className, onReady, onError }: MediaProps) {
  const [ready, setReady] = useState(false);
  return <img className={className} src={media.url} alt="" draggable={false} decoding="async"
    style={{ visibility: ready ? undefined : 'hidden' }}
    onLoad={async event => {
      const image = event.currentTarget;
      try { await image.decode(); } catch { /* A loaded image can still paint if predecoding is unavailable. */ }
      if (image.isConnected && image.complete && image.naturalWidth > 0) {
        setReady(true);
        onReady?.(media.url);
      }
    }}
    onError={onError} />;
}

function VideoStill({ media, className, onReady, onError }: MediaProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = media.url;

    const fail = () => {
      if (!cancelled) onError?.();
    };

    const capture = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas || video.videoWidth <= 0 || video.videoHeight <= 0) {
        fail();
        return;
      }
      // Cap the still frame so a 4K loop does not keep a full-resolution canvas texture.
      const maxEdge = 2560;
      const edge = Math.max(video.videoWidth, video.videoHeight);
      const scale = edge > maxEdge ? maxEdge / edge : 1;
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        fail();
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      setReady(true);
      onReady?.(media.url);
      video.removeAttribute('src');
      video.load();
    };

    video.addEventListener('loadeddata', capture, { once: true });
    video.addEventListener('error', fail, { once: true });
    return () => {
      cancelled = true;
      video.removeAttribute('src');
      video.load();
    };
  }, [media.url, onError, onReady]);

  return <canvas
    ref={canvasRef}
    className={className}
    aria-hidden="true"
    style={{ visibility: ready ? undefined : 'hidden' }}
  />;
}

function BackgroundMediaNodeComponent({ media, className, onReady, onError, still = false }: MediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stillFailed, setStillFailed] = useState(false);

  useEffect(() => {
    if (still && !stillFailed) return;
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
  }, [media.url, still, stillFailed]);

  useEffect(() => {
    setStillFailed(false);
  }, [media.url]);

  if (media.kind === 'video' && still && !stillFailed) {
    return <VideoStill
      media={media}
      className={className}
      onReady={onReady}
      onError={() => {
        setStillFailed(true);
      }}
    />;
  }

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
        onLoadedData={() => onReady?.(media.url)}
        onError={onError}
      />
    );
  }
  return <BackgroundImage key={media.url} media={media} className={className} onReady={onReady} onError={onError} />;
}

export const BackgroundMediaNode = memo(BackgroundMediaNodeComponent);

function BackgroundLayerComponent({
  media,
  opacity,
  blur,
  scrim,
  onReady,
  onError,
  still = false,
}: {
  media: BackgroundMedia;
  opacity: number;
  blur: number;
  /** 壁纸遮罩强度 0–100：只压暗窗口外的壁纸，不影响窗口内表面。 */
  scrim: number;
  onReady?: (url: string) => void;
  onError?: () => void;
  still?: boolean;
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
    <div className={`background-layer${blurPixels === 0 ? ' is-sharp' : ''}`} style={style} aria-hidden="true">
      <BackgroundMediaNode key={media.url} media={media} className="background-layer-media" still={still} onReady={onReady} onError={onError} />
      <div className="background-layer-soften" />
      <div className="wallpaper-drag-edge top" />
      <div className="wallpaper-drag-edge left" />
      <div className="wallpaper-drag-edge right" />
      <div className="wallpaper-drag-edge bottom" />
    </div>
  );
}

export const BackgroundLayer = memo(BackgroundLayerComponent);

export function BackgroundMediaPreview({ media, onError }: { media: BackgroundMedia; onError?: () => void }) {
  return (
    <div className="background-media-preview">
      <BackgroundMediaNode key={media.url} media={media} className="background-media-preview-content" onError={onError} />
      <span className="background-media-preview-kind">{media.kind === 'video' ? '动态视频' : '图片背景'}</span>
    </div>
  );
}
