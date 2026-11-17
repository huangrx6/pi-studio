import { ALL_FORMATS, AudioBufferSink, CanvasSink, CustomSource, Input } from 'mediabunny';
import type { StoryboardAsset } from '../../../types/storyboard-types';
import { sampleRate, type Scene } from './timeline';

type RangeRead = (id: string, start: number, size: number) => Promise<string>;
type Source = { image?: ImageBitmap; video?: CanvasSink; audio?: AudioBufferSink; origin: number; videoStart: number };
const block = 1024 * 1024;

export function filmMedia(assets: StoryboardAsset[], sizes: Record<string, number>, read: RangeRead, signal: AbortSignal) {
  const opened = new Map<string, Promise<Source>>();
  const resources: { dispose: () => void }[] = [];
  async function bytes(id: string, start: number, end: number) {
    const result = new Uint8Array(end - start);
    for (let offset = 0; offset < result.length; offset += block) {
      signal.throwIfAborted();
      const data = atob(await read(id, start + offset, Math.min(block, result.length - offset)));
      for (let i = 0; i < data.length; i++) result[offset + i] = data.charCodeAt(i);
    }
    return result;
  }
  async function open(id: string): Promise<Source> {
    const asset = assets.find(a => a.id === id)!;
    try {
      if (asset.kind === 'image') {
        const image = await createImageBitmap(new Blob([await bytes(id, 0, sizes[id])]));
        resources.push({ dispose: () => image.close() });
        return { image, origin: 0, videoStart: 0 };
      }
      const input = new Input({ formats: ALL_FORMATS, source: new CustomSource({
        getSize: () => sizes[id], read: (start, end) => bytes(id, start, end), prefetchProfile: 'fileSystem',
      }) });
      resources.push(input);
      const video = await input.getPrimaryVideoTrack();
      const audio = await input.getPrimaryAudioTrack();
      if (asset.kind === 'video' && (!video || !await video.canDecode())) throw new Error('无法解码画面');
      if (audio && !await audio.canDecode()) throw new Error('无法解码声音');
      if (asset.kind === 'audio' && !audio) throw new Error('没有音轨');
      const origin = Math.max(0, await input.getFirstTimestamp());
      return { origin, videoStart: video ? Math.max(origin, await video.getFirstTimestamp()) : origin,
        video: video ? new CanvasSink(video, { width: Math.min(1600, video.displayWidth), poolSize: 2 }) : undefined,
        audio: audio ? new AudioBufferSink(audio) : undefined };
    } catch (cause) {
      signal.throwIfAborted();
      throw new Error(`「${asset.name}」读取失败：${cause instanceof Error ? cause.message : '请检查素材格式'}`);
    }
  }
  return {
    get(id: string) {
      if (!opened.has(id)) opened.set(id, open(id));
      return opened.get(id)!;
    },
    dispose() { for (const item of resources) item.dispose(); },
  };
}

export type FilmMedia = ReturnType<typeof filmMedia>;

// Mix at most one second of stereo PCM. All offsets use the same 48 kHz clock as the video frames.
export async function mixBlock(media: FilmMedia, scene: Scene, start: number, samples: number, signal: AbortSignal) {
  const result = new AudioBuffer({ numberOfChannels: 2, sampleRate, length: samples });
  for (const clip of scene.sounds) {
    const lo = Math.max(start, clip.from), hi = Math.min(start + samples / sampleRate, clip.until);
    if (hi <= lo) continue;
    const { audio, origin } = await media.get(clip.assetId);
    if (!audio) continue;
    const sourceTime = origin + lo - clip.from;
    for await (const { buffer, timestamp } of audio.buffers(sourceTime, origin + hi - clip.from)) {
      signal.throwIfAborted();
      const base = clip.from + timestamp - origin - start;
      const first = Math.max(0, Math.round((lo - start) * sampleRate), Math.ceil(base * sampleRate - 1e-6));
      const last = Math.min(samples, Math.round((hi - start) * sampleRate), Math.ceil((base + buffer.duration) * sampleRate - 1e-6));
      for (let channel = 0; channel < 2; channel++) {
        const dest = result.getChannelData(channel);
        const src = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
        for (let i = first; i < last; i++) {
          const pos = Math.max(0, (i / sampleRate - base) * buffer.sampleRate);
          const k = Math.min(src.length - 1, Math.floor(pos));
          const next = src[Math.min(src.length - 1, k + 1)];
          dest[i] += (src[k] + (next - src[k]) * (pos - k)) * clip.gain;
        }
      }
    }
  }
  return result;
}
