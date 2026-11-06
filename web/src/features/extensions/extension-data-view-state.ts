import type { ExtensionDataViewSnapshot } from '../../types/extension-types';

export type OwnedExtensionDataViewSnapshot = Readonly<{
  subscriptionId: string;
  snapshot: ExtensionDataViewSnapshot;
}>;

export function extensionDataViewRequestKey(
  sourceId: string,
  cwd?: string,
  sessionId?: string,
  modelRef?: string,
): string {
  return JSON.stringify([sourceId, cwd ?? null, sessionId ?? null, modelRef ?? null]);
}

export function acceptsExtensionDataViewSnapshot(
  current: OwnedExtensionDataViewSnapshot | null,
  subscriptionId: string,
  next: ExtensionDataViewSnapshot,
): boolean {
  if (!current || current.subscriptionId !== subscriptionId) return true;
  return current.snapshot.revision <= next.revision;
}
