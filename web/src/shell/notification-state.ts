export type NotificationTone = 'info' | 'success' | 'warning' | 'error';

export type AppNotificationAction = {
  kind: 'unarchive-session';
  label: string;
  pendingLabel: string;
  sessionId: string;
  /** The action replaces the source link while the session is archived. */
  hideSessionLink?: boolean;
};

export type AppNotification = {
  id: string;
  title: string;
  message: string;
  tone: NotificationTone;
  createdAt: number;
  updatedAt?: number;
  read: boolean;
  /** Only attach an explicitly known originating conversation. */
  sessionId?: string;
  action?: AppNotificationAction;
};

const MERGE_WINDOW_MS = 30_000;
const NOTIFICATION_LIMIT = 50;

export function notificationTitle(tone: NotificationTone) {
  if (tone === 'success') return '操作完成';
  if (tone === 'warning') return '需要注意';
  if (tone === 'error') return '操作未完成';
  return 'Pi Studio';
}

/** Keep the list scannable while preserving the complete message on demand. */
export function notificationMessagePresentation(message: string) {
  const normalized = String(message || '').trim() || '操作已完成';
  const lines = normalized.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const first = lines[0] || '操作已完成';
  const summary = first.length > 180 ? `${first.slice(0, 180)}…` : first;
  return {
    summary,
    details: lines.length > 1 || first.length > 180 ? normalized : null,
  };
}

/** Coalesce a repeated event without erasing older history or crossing sources. */
export function mergeNotification(items: AppNotification[], incoming: AppNotification): AppNotification[] {
  const timestamp = incoming.updatedAt ?? incoming.createdAt;
  let candidateIndex = -1;
  let candidateTime = Number.NEGATIVE_INFINITY;

  items.forEach((item, index) => {
    const previousTime = item.updatedAt ?? item.createdAt;
    const elapsed = timestamp - previousTime;
    if (item.title === incoming.title
      && item.message === incoming.message
      && item.tone === incoming.tone
      && item.sessionId === incoming.sessionId
      && item.action?.kind === incoming.action?.kind
      && item.action?.sessionId === incoming.action?.sessionId
      && elapsed >= 0 && elapsed <= MERGE_WINDOW_MS
      && previousTime > candidateTime) {
      candidateIndex = index;
      candidateTime = previousTime;
    }
  });

  const previous = items[candidateIndex];
  const next: AppNotification = previous
    ? { ...incoming, id: previous.id, createdAt: previous.createdAt, updatedAt: timestamp, read: false }
    : { ...incoming, read: false };
  return [next, ...items.filter((_, index) => index !== candidateIndex)].slice(0, NOTIFICATION_LIMIT);
}
