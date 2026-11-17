import { CanvasSource, Mp4OutputFormat, Output, StreamTarget, canEncodeAudio, canEncodeVideo } from 'mediabunny';
import { filmAudio } from './audio-track';
import type { StoryboardWork } from '../../../types/storyboard-types';
import { drawFrame } from './draw-frame';
import { filmMedia, mixBlock } from './media';
import { filmTimeline, fps, sampleRate } from './timeline';

function base64(bytes: Uint8Array) {
  let value = '';
  for (let i = 0; i < bytes.length; i += 32_768) value += String.fromCharCode(...bytes.subarray(i, i + 32_768));
  return btoa(value);
}
function* timestamps(origin: number, firstPicture: number, count: number) {
  for (let i = 0; i < count; i++) yield Math.max(firstPicture, origin + i / fps);
}

export async function renderFilm(workspace: string, work: StoryboardWork, plan: string, signal: AbortSignal, progress: (n: number) => void) {
  const film = filmTimeline(work.document, plan);
  const { width, height } = film;
  if (!film.frames) throw new Error('此方案没有镜头');
  if (!await canEncodeVideo('avc', { width, height, bitrate: 4_000_000 })) throw new Error('当前设备未提供 H.264 编码器');
  const api = window.piApi;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const previous = new OffscreenCanvas(width, height);
  const old = previous.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(new WritableStream({
    async write({ data, position }) {
      signal.throwIfAborted();
      for (let i = 0; i < data.length; i += 1_048_576) await api.storyboardRenderWrite(...args, position + i, base64(data.subarray(i, i + 1_048_576)));
    },
  }), { chunked: true, chunkSize: 1024 * 1024 }) });
  signal.throwIfAborted();
  const job = await api.storyboardRenderBegin(workspace, work.id, plan, work.revision);
  const args = [workspace, work.id, job.id] as const;
  const media = filmMedia(work.document.assets, job.sizes, (id, start, size) => api.storyboardRenderRead(...args, id, start, size), signal);
  let complete = false;
  let audio: ReturnType<typeof filmAudio> | undefined;
  try {
    let audible = false;
    for (const scene of film.scenes) {
      for (const clip of scene.sounds) {
        if ((await media.get(clip.assetId)).audio) { audible = true; break; }
      }
      if (audible) break;
    }
    if (audible && !await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate, bitrate: 128000 })) throw new Error('当前设备未提供 AAC 编码器');
    const video = new CanvasSource(canvas, { codec: 'avc', bitrate: 4_000_000, keyFrameInterval: 1 });
    output.addVideoTrack(video, { frameRate: fps });
    if (audible) {
      audio = filmAudio(film.frames / fps);
      output.addAudioTrack(audio.track);
      await audio.start();
    }
    await output.start();
    for (const scene of film.scenes) {
      const dissolve = scene.first > 0 && scene.shot.composition?.transition === 'dissolve' ? Math.min(12, scene.frames) : 0;
      if (dissolve) old.drawImage(canvas, 0, 0);
      const visuals = scene.visuals.length ? scene.visuals : [null];
      for (const [slot, id] of visuals.entries()) {
        const from = Math.ceil(slot * scene.frames / visuals.length);
        const until = Math.ceil((slot + 1) * scene.frames / visuals.length);
        const source = id ? await media.get(id) : undefined;
        const frames = source?.video?.canvasesAtTimestamps(timestamps(source.origin, source.videoStart, until - from));
        try {
          for (let i = from; i < until; i++) {
            signal.throwIfAborted();
            const picture = source?.image ?? (await frames?.next())?.value?.canvas;
            if (id && !picture) throw new Error(`「${scene.shot.purpose}」缺少可解码的画面`);
            drawFrame(ctx, scene, i, picture, work.document.title || '分镜作品');
            if (i < dissolve) {
              ctx.globalAlpha = 1 - (i + 1) / dissolve; ctx.drawImage(previous, 0, 0); ctx.globalAlpha = 1;
            }
            await video.add((scene.first + i) / fps, 1 / fps);
            if (audio && i % fps === 0) {
              const samples = Math.min(fps, scene.frames - i) * (sampleRate / fps);
              await audio.add(await mixBlock(media, scene, i / fps, samples, signal));
            }
            if (i % 6 === 0) progress(Math.floor((scene.first + i) * 100 / film.frames));
          }
        } finally { await frames?.return(); }
      }
    }
    signal.throwIfAborted();
    await audio?.finish();
    await output.finalize();
    const url = await api.storyboardRenderFinish(...args);
    signal.throwIfAborted();
    complete = true;
    return { id: job.id, url, revision: work.document.renderRevision ?? work.revision };
  } finally {
    try {
      if (!complete) {
        try {
          await audio?.dispose();
          if (output.state === 'started') await output.cancel();
        } finally { await api.storyboardRenderDiscard(...args); }
      }
    } finally {
      media.dispose();
    }
  }
}
