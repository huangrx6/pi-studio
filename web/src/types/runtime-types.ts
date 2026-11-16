export type StudioRuntimeVersions = {
  durable: string;
  electron?: string;
  chromium?: string;
  node: string;
  sqlite?: string;
  platform: string;
  arch: string;
};

/** Result sent after a settings save asks live Pi sessions to reload. */
export type RuntimeRefreshStatus = 'applied' | 'pending' | 'partial' | 'error' | 'ready';

export type RuntimeRefreshSnapshot = {
  status: RuntimeRefreshStatus;
  revision: number;
  reason: string;
  appliedSessions: number;
  pendingSessions: number;
  failedSessions: number;
  sessionId?: string;
  background: boolean;
  message: string;
  errors: string[];
  at: number;
};
