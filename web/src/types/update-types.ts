/** Desktop updater snapshot shared by the brand control, menu and dialog. */
export interface UpdateSnapshot {
  currentVersion: string;
  currentBuildId?: string;
  state: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error' | 'unsupported';
  latestVersion?: string;
  latestBuildId?: string;
  updateKind?: 'version' | 'same-version';
  releaseName?: string;
  releaseNotes?: string;
  publishedAt?: string;
  progress?: number;
  transferred?: number;
  total?: number;
  /** 本次更新的完整安装包大小（zip）。与 total 比较可判断是否为增量下载。 */
  packageSize?: number;
  bytesPerSecond?: number;
  error?: string;
  checkedAt?: number;
}
