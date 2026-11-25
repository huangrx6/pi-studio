export type StorageCategory = 'database' | 'attachments' | 'worktrees' | 'resources' | 'media' | 'client' | 'other';
export type StorageLocation = {
  id: string;
  kind: 'studio' | 'client' | 'session' | 'database' | 'worktrees' | 'project' | 'updates';
  name: string;
  place: string;
  shared?: boolean;
  bytes: number;
  status: 'ready' | 'partial' | 'unavailable';
  canOpen: boolean;
};

export type DeviceStorageSnapshot = {
  totalBytes: number;
  categories: Record<StorageCategory, number>;
  measuredAt: number;
  locationsIncomplete: boolean;
  locations: StorageLocation[];
};
