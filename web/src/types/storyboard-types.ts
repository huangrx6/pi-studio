export type VideoGenre = 'free' | 'education' | 'wedding' | 'product';
export type VideoAspect = 'auto' | '16:9' | '9:16' | '1:1';
export type StoryboardBrief = { title: string; genre: VideoGenre; aspect: VideoAspect; idea: string };
export type MediaKind = 'speech' | 'image';
export type MediaModelRef = { providerId: string; modelId: string };
export type MediaModelCatalog = Record<MediaKind, Array<MediaModelRef & { label: string }>>;
export type MediaPreferences = { speech?: MediaModelRef & { voice?: string }; image?: MediaModelRef };
export type MediaGenerationInput = MediaModelRef & { kind: MediaKind; shotId: string; prompt: string; voice?: string };
export type StoryboardAsset = {
  id: string; name: string; kind: 'image' | 'video' | 'audio' | 'document'; size: number;
  generated?: MediaGenerationInput & { durationMs?: number };
};
export type StoryboardDirection = {
  id: string;
  title: string;
  beats: string[];
  need?: { label: string; kinds: StoryboardAsset['kind'][]; count: number; select?: boolean };
};
export type StoryboardReplyAction =
  | { action: 'start' | 'explore' | 'defer' | 'approve' }
  | { action: 'answer'; text: string }
  | { action: 'choose'; choiceId: string }
  | { action: 'materials'; assetIds: string[] };
export type StoryboardReply = StoryboardReplyAction & {
  parentId: string; requestId: string; modelRef?: string; mode?: 'ai' | 'basic';
};
export type StoryboardNode = {
  id: string;
  parentId: string | null;
  kind: 'idea' | 'question' | 'direction' | 'materials' | 'review';
  question: string;
  answer: string;
  assetIds: string[];
  chosenPlanId: string | null;
  step?: {
    brief: { idea: string; genre: VideoGenre; aspect: VideoAspect; focus: string };
    reply: string;
    reason: string;
    modelRef?: string; choiceId?: string; selectedAssetIds?: string[];
    options?: StoryboardDirection[];
    direction?: StoryboardDirection;
    deferred?: string;
  };
};
export type StoryboardPlan = { id: string; version: number; nodeId: string; summary: string; assetIds: string[] };
export type StoryboardCallout = {
  x: number; y: number; width: number; height: number; startMs: number; endMs: number; label?: string;
};
export type StoryboardShot = {
  id: string;
  planId: string;
  durationMs: number;
  purpose: string;
  framing: string;
  subjects: string;
  setting: string;
  motion: string;
  assetIds: string[];
  captions: { startMs: number; endMs: number; text: string }[];
  sound: string;
  composition?: { camera?: 'still' | 'push' | 'pull'; transition?: 'cut' | 'dissolve'; heading?: string;
    pointer?: { x: number; y: number; atMs: number }; callout?: StoryboardCallout; volume?: number; mutedAudioIds?: string[] };
};
export type ShotPatch = Partial<Pick<StoryboardShot, 'purpose' | 'framing' | 'subjects' | 'setting' | 'motion' | 'sound' | 'durationMs' | 'assetIds' | 'composition' | 'captions'>>;
export type ProductionInput = { planId: string; reuse?: { index: number; shotId: string }[] };
export type StoryboardDraftRequest = { planId: string; shotId?: string; instruction?: string; modelRef?: string };
export type StoryboardDraftPreview = { id: string; modelRef: string; skillNames: string[]; shots: StoryboardShot[] };
export type AssetPreview = { missing: boolean; size?: number; url?: string; thumbnail?: string; text?: string };
export type StoryboardTrack = {
  id: string;
  role: 'original' | 'narration' | 'music' | 'effect';
  clips: { shotId: string; assetId: string; offsetMs: number; durationMs: number; gainDb: number }[];
};
export type StoryboardDocument = {
  schemaVersion: 1;
  title: string;
  genre: VideoGenre;
  aspect: VideoAspect;
  assets: StoryboardAsset[];
  activeNodeId: string;
  approvedPlanId: string | null;
  nodes: StoryboardNode[];
  plans: StoryboardPlan[];
  shots: StoryboardShot[];
  tracks: StoryboardTrack[];
  mediaPreferences?: MediaPreferences;
  /** Older works use the enclosing work revision until their first edit. */
  renderRevision?: number;
};
export type StoryboardSummary = { id: string; title: string; updatedAt: number };
export type StoryboardWork = {
  id: string; revision: number; updatedAt: number; document: StoryboardDocument;
  /** Present on the confirmation response that created this version's initial shots. */
  productionCreated?: boolean;
};
