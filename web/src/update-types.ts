/** Desktop updater snapshot shared by the brand control, menu and dialog. */
export interface UpdateSnapshot {
  currentVersion: string;
  state: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error' | 'unsupported';
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  publishedAt?: string;
  progress?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  error?: string;
  checkedAt?: number;
}
