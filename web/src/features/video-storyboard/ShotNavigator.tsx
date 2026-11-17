import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Clapperboard, Image as ImageIcon, Type, Video } from 'lucide-react';
import type { StoryboardAsset, StoryboardShot } from '../../types/storyboard-types';
import { loadStoryboardAssetPreview } from './storyboard-asset-preview';

function ShotThumbnail({ workspace, workId, asset }: { workspace: string; workId: string; asset?: StoryboardAsset }) {
  const box = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState('');
  const [hasFrame, setHasFrame] = useState(false);
  const { id, kind, name, size } = asset ?? {};
  useEffect(() => {
    setUrl(''); setHasFrame(false);
    if (!id || (kind !== 'image' && kind !== 'video') || name === undefined || size === undefined || !box.current) return;
    let active = true;
    let player: HTMLVideoElement | undefined;
    function releasePlayer() {
      if (!player) return;
      player.onloadeddata = null;
      player.onerror = null;
      player.removeAttribute('src');
      player.load();
      player = undefined;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void loadStoryboardAssetPreview(workspace, workId, { id, kind, name, size }).then(info => {
        if (!active || info.missing) return;
        if (info.thumbnail || kind === 'image') {
          setUrl(info.thumbnail || info.url || '');
        } else if (info.url) {
          // Retain only a tiny first frame, not a decoder for every shot in the sequence.
          player = document.createElement('video');
          player.preload = 'auto';
          player.muted = true;
          player.onloadeddata = () => {
            const target = canvas.current;
            if (target && player?.videoWidth && player.videoHeight) {
              const scale = 128 / Math.max(player.videoWidth, player.videoHeight);
              target.width = Math.max(1, Math.round(player.videoWidth * scale));
              target.height = Math.max(1, Math.round(player.videoHeight * scale));
              const ctx = target.getContext('2d');
              if (ctx) {
                ctx.drawImage(player, 0, 0, target.width, target.height);
                setHasFrame(true);
              }
            }
            releasePlayer();
          };
          player.onerror = releasePlayer;
          player.src = info.url;
        }
      }).catch(() => {});
    });
    observer.observe(box.current);
    return () => { active = false; observer.disconnect(); releasePlayer(); };
  }, [workspace, workId, id, kind, name, size]);
  const Icon = kind === 'video' ? Video : kind === 'image' ? ImageIcon : Type;
  return <span className="story-shot-thumb" ref={box} aria-hidden>
    {kind === 'video' && <canvas ref={canvas} hidden={!hasFrame} />}
    {url ? <img src={url} alt="" onError={() => setUrl('')} /> : !hasFrame && <Icon />}
  </span>;
}

export function ShotNavigator({ workspace, workId, assets, shots, selected, select }: {
  workspace: string; workId: string; assets: StoryboardAsset[]; shots: StoryboardShot[]; selected: number; select: (id: string) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = rail.current, button = list?.children[selected];
    if (!list || !button) return;
    // Keep external selections visible without scrolling the whole panel away from the editor.
    const outer = list.getBoundingClientRect(), inner = button.getBoundingClientRect();
    if (inner.left < outer.left) list.scrollLeft += inner.left - outer.left;
    else if (inner.right > outer.right) list.scrollLeft += inner.right - outer.right;
    if (inner.top < outer.top) list.scrollTop += inner.top - outer.top;
    else if (inner.bottom > outer.bottom) list.scrollTop += inner.bottom - outer.bottom;
  }, [selected]);
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const targets: Record<string, number> = { ArrowLeft: index - 1, ArrowUp: index - 1, ArrowRight: index + 1, ArrowDown: index + 1, Home: 0, End: shots.length - 1 };
    if (!(event.key in targets)) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(shots.length - 1, targets[event.key]));
    select(shots[target].id);
    (rail.current?.children[target] as HTMLButtonElement | undefined)?.focus({ preventScroll: true });
  }
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return <nav className="story-shot-picker" aria-label="镜头列表">
    <header><Clapperboard aria-hidden /><h3>镜头列表</h3><small>{selected + 1} / {shots.length}</small></header>
    <div className="story-shot-rail" ref={rail}>
      {shots.map((shot, index) => {
        const asset = shot.assetIds.map(id => byId.get(id)).find(asset => asset?.kind === 'image' || asset?.kind === 'video');
        return <button key={shot.id} type="button" aria-pressed={selected === index} aria-label={`选择镜头 ${index + 1}`}
          title={shot.purpose || '未命名镜头'} onKeyDown={event => keyboard(event, index)} onClick={() => select(shot.id)}>
          <ShotThumbnail workspace={workspace} workId={workId} asset={asset} />
          <span className="story-shot-caption"><span><b>{String(index + 1).padStart(2, '0')}</b><small>{shot.durationMs / 1000} 秒</small></span>
            <strong>{shot.purpose || '未命名镜头'}</strong></span>
        </button>;
      })}
    </div>
  </nav>;
}
