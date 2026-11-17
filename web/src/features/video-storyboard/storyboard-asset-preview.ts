import type { AssetPreview, StoryboardAsset } from '../../types/storyboard-types';

const pending = new Map<string, Promise<AssetPreview>>();

// The shot list, editor and player can request the same thumbnail in the same render.
export function loadStoryboardAssetPreview(workspace: string, workId: string, asset: StoryboardAsset): Promise<AssetPreview> {
  const key = JSON.stringify([workspace, workId, asset.id, asset.name, asset.size]);
  let request = pending.get(key);
  if (!request) {
    request = window.piApi.storyboardPreview(workspace, workId, asset.id).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}
