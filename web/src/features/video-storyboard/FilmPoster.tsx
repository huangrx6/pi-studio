import { useEffect, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { StoryboardAsset } from '../../types/storyboard-types';
import { drawFrame } from './film/draw-frame';
import { fps, posterFrame, type Scene } from './film/timeline';
import { loadStoryboardAssetPreview } from './storyboard-asset-preview';

type Props = {
  workspace: string; workId: string; title: string; width: number; height: number;
  scene: Scene; assets: StoryboardAsset[];
};

export function FilmPoster({ workspace, workId, title, width, height, scene, assets }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const frame = posterFrame(scene);
  const slot = Math.floor(frame * scene.visuals.length / scene.frames);
  const asset = assets.find(item => item.id === scene.visuals[slot]);
  const slotStart = scene.visuals.length ? Math.ceil(slot * scene.frames / scene.visuals.length) : 0;
  const sourceTime = (frame - slotStart) / fps;
  useEffect(() => {
    const view = canvas.current?.getContext('2d');
    if (!view) return;
    let active = true;
    let fallback = '';
    let source: HTMLImageElement | HTMLVideoElement | undefined;
    setReason('');
    setLoading(Boolean(asset));
    function paint(picture?: OffscreenCanvas) {
      if (!active) return;
      const still = new OffscreenCanvas(width, height);
      const ctx = still.getContext('2d');
      if (!ctx) return;
      drawFrame(ctx, scene, frame, picture, title || '分镜作品');
      view!.drawImage(still, 0, 0);
      setLoading(false);
    }
    // Text-only shots use the same title card as the encoder.
    if (!asset) { paint(); return; }
    function unavailable() {
      if (!active) return;
      if (source instanceof HTMLImageElement && fallback) {
        source.src = fallback;
        fallback = '';
      } else setReason('素材暂时无法预览');
    }
    function releaseSource() {
      if (!source) return;
      source.onerror = null;
      if (source instanceof HTMLVideoElement) {
        source.onloadeddata = null;
        source.onseeked = null;
        source.removeAttribute('src');
        source.load();
      } else { source.onload = null; source.removeAttribute('src'); }
      source = undefined;
    }
    function drawSource() {
      if (!source || !active) return;
      try {
        const w = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
        const h = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
        if (!w || !h) { unavailable(); return; }
        const scale = Math.min(1, Math.max(width, height) / Math.max(w, h));
        const picture = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
        picture.getContext('2d')!.drawImage(source, 0, 0, picture.width, picture.height);
        paint(picture);
        releaseSource();
      } catch { unavailable(); }
    }
    void loadStoryboardAssetPreview(workspace, workId, asset).then(preview => {
      if (!active) return;
      const url = preview.url || preview.thumbnail;
      if (!url || preview.missing) { setReason(preview.missing ? '找不到镜头素材' : '素材暂时无法预览'); return; }
      if (asset.kind === 'video') {
        const movie = document.createElement('video');
        movie.muted = true; movie.preload = 'auto';
        movie.onloadeddata = () => {
          movie.onloadeddata = null;
          const end = Number.isFinite(movie.duration) ? Math.max(0, movie.duration - .001) : sourceTime;
          const target = Math.min(end, sourceTime);
          if (Math.abs(movie.currentTime - target) < .001) drawSource();
          else { movie.onseeked = drawSource; movie.currentTime = target; }
        };
        source = movie;
      } else {
        const image = new Image();
        image.onload = drawSource;
        source = image;
        if (preview.url && preview.thumbnail) fallback = preview.thumbnail;
      }
      source.onerror = unavailable;
      source.src = url;
    }).catch(() => { if (active) setReason('素材暂时无法预览'); });
    return () => {
      active = false;
      releaseSource();
    };
  }, [workspace, workId, title, width, height, scene, asset, frame, sourceTime]);
  return <div className="story-film-stage" data-portrait={height > width}>
    <canvas ref={canvas} width={width} height={height} aria-label={scene.shot.purpose + ' · 分镜静帧'} />
    {reason ? <div className="story-film-unavailable"><ImageOff aria-hidden />{reason}</div>
      : loading && <div className="story-film-loading">正在读取镜头画面…</div>}
  </div>;
}
