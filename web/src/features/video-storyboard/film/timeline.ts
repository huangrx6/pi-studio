import type { StoryboardDocument, StoryboardShot } from '../../../types/storyboard-types';

export const fps = 30;
export const sampleRate = 48000;
export type Sound = { assetId: string; from: number; until: number; gain: number };
export type Scene = { shot: StoryboardShot; first: number; frames: number; visuals: string[]; sounds: Sound[] };

export function posterFrame(scene: Scene) {
  const last = scene.frames - 1;
  const { pointer, callout } = scene.shot.composition ?? {};
  const clickFrame = pointer ? Math.min(last, Math.ceil(pointer.atMs * fps / 1000) + 2) : undefined;
  if (callout) {
    const first = Math.ceil(callout.startMs * fps / 1000);
    const end = Math.min(last, Math.ceil(callout.endMs * fps / 1000) - 1);
    if (first <= end) {
      const fade = Math.min(160, (callout.endMs - callout.startMs) / 3);
      const clickMs = (clickFrame ?? -1) * 1000 / fps;
      if (clickFrame !== undefined && clickMs >= callout.startMs + fade && clickMs <= callout.endMs - fade) return clickFrame;
      return Math.round((first + end) / 2);
    }
  }
  if (clickFrame !== undefined) return clickFrame;
  const captions = scene.shot.captions.flatMap(cue => {
    const first = Math.ceil(cue.startMs * fps / 1000);
    return cue.text.trim() && first <= last && first * 1000 / fps < cue.endMs ? [first] : [];
  });
  return captions.length ? Math.min(...captions) : 0;
}

export function filmTimeline(doc: StoryboardDocument, planId: string) {
  const plan = doc.plans.find(item => item.id === planId);
  const aspect = doc.nodes.find(n => n.id === plan?.nodeId)?.step?.brief.aspect ?? doc.aspect;
  const [width, height] = aspect === '9:16' ? [720, 1280] : aspect === '1:1' ? [960, 960] : [1280, 720];
  const kinds = new Map(doc.assets.map(a => [a.id, a.kind]));
  const tracks = doc.tracks.flatMap(track => track.clips);
  let first = 0;
  let duration = 0;
  const scenes: Scene[] = [];
  for (const shot of doc.shots.filter(s => s.planId === planId)) {
    duration += shot.durationMs;
    const frames = Math.max(1, Math.round(duration * fps / 1000) - first);
    const visuals = shot.assetIds.filter(id => ['video', 'image'].includes(kinds.get(id) || ''));
    const length = frames / fps;
    const volume = shot.composition?.volume ?? 1;
    const explicit = tracks.filter(c => c.shotId === shot.id);
    const sounds: Sound[] = explicit.map(c => ({ assetId: c.assetId, from: c.offsetMs / 1000,
      until: Math.min(length, (c.offsetMs + c.durationMs) / 1000), gain: 10 ** (c.gainDb / 20) * volume }));
    for (const assetId of shot.assetIds) {
      if (explicit.some(c => c.assetId === assetId)) continue;
      const kind = kinds.get(assetId);
      if (kind === 'audio') sounds.push({ assetId, from: 0, until: length, gain: volume });
      if (kind === 'video') {
        const i = visuals.indexOf(assetId);
        sounds.push({ assetId, from: Math.ceil(i * frames / visuals.length) / fps,
          until: Math.ceil((i + 1) * frames / visuals.length) / fps, gain: volume });
      }
    }
    scenes.push({ shot, first, frames, visuals, sounds: sounds.filter(s =>
      s.until > s.from && s.gain > 0 && !shot.composition?.mutedAudioIds?.includes(s.assetId)) });
    first += frames;
  }
  return { width, height, scenes, frames: first };
}
