/**
 * Pure state transitions for the desktop updater.
 *
 * Keeping this module free of Electron imports lets the state machine be tested
 * without starting an app or touching the network. The updater service owns
 * timers, notifications and electron-updater; this file only decides which
 * snapshot the renderer should see after each updater event.
 */

const UPDATE_STATES = new Set([
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'downloaded',
  'error',
  'unsupported',
]);

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, number));
}

/** Convert GitHub release notes to readable plain text without rendering HTML. */
function normalizeReleaseNotes(value) {
  const raw = Array.isArray(value)
    ? value.map((entry) => entry?.note ?? entry).filter(Boolean).join('\n\n')
    : value;
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 8_000);
}

function fieldsFromInfo(info = {}) {
  return {
    latestVersion: typeof info.version === 'string' ? info.version : undefined,
    releaseName: typeof info.releaseName === 'string' && info.releaseName.trim()
      ? info.releaseName.trim()
      : undefined,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes) || undefined,
    publishedAt: typeof info.releaseDate === 'string' ? info.releaseDate : undefined,
  };
}

function initialUpdateState(currentVersion = '') {
  return {
    currentVersion,
    state: 'idle',
    checkedAt: undefined,
    latestVersion: undefined,
    releaseName: undefined,
    releaseNotes: undefined,
    publishedAt: undefined,
    progress: undefined,
    transferred: undefined,
    total: undefined,
    bytesPerSecond: undefined,
    error: undefined,
  };
}

/**
 * Apply one updater event to a snapshot.
 *
 * `checking` and `available` reset progress; download progress is deliberately
 * monotonic while a download is active so out-of-order renderer deliveries do
 * not make the percentage jump backwards.
 */
function reduceUpdateState(current, event = {}) {
  const base = current?.currentVersion !== undefined
    ? { ...initialUpdateState(), ...current }
    : initialUpdateState();
  const type = UPDATE_STATES.has(event.type) || event.type === 'progress'
    ? event.type
    : 'idle';

  if (type === 'checking') {
    return {
      ...base,
      state: 'checking',
      checkedAt: Date.now(),
      progress: undefined,
      transferred: undefined,
      total: undefined,
      bytesPerSecond: undefined,
      error: undefined,
    };
  }

  if (type === 'available') {
    return {
      ...base,
      ...fieldsFromInfo(event.info),
      state: 'available',
      checkedAt: Date.now(),
      progress: 0,
      transferred: undefined,
      total: undefined,
      bytesPerSecond: undefined,
      error: undefined,
    };
  }

  if (type === 'up-to-date') {
    return {
      ...base,
      state: 'up-to-date',
      latestVersion: event.info?.version || base.currentVersion,
      checkedAt: Date.now(),
      progress: undefined,
      transferred: undefined,
      total: undefined,
      bytesPerSecond: undefined,
      error: undefined,
    };
  }

  if (type === 'downloading') {
    return {
      ...base,
      state: 'downloading',
      progress: base.progress ?? 0,
      transferred: base.transferred ?? 0,
      total: base.total,
      bytesPerSecond: base.bytesPerSecond,
      error: undefined,
    };
  }

  if (type === 'progress') {
    const nextProgress = clampPercent(event.progress?.percent);
    return {
      ...base,
      state: 'downloading',
      progress: Math.max(base.progress ?? 0, nextProgress),
      transferred: Number(event.progress?.transferred) || 0,
      total: Number(event.progress?.total) || undefined,
      bytesPerSecond: Number(event.progress?.bytesPerSecond) || 0,
      error: undefined,
    };
  }

  if (type === 'downloaded') {
    return {
      ...base,
      ...fieldsFromInfo(event.info),
      state: 'downloaded',
      progress: 100,
      transferred: base.total || base.transferred,
      bytesPerSecond: 0,
      checkedAt: Date.now(),
      error: undefined,
    };
  }

  if (type === 'error') {
    return {
      ...base,
      state: 'error',
      error: typeof event.error === 'string' && event.error.trim()
        ? event.error.trim()
        : '更新操作暂时失败，请稍后重试。',
    };
  }

  if (type === 'unsupported') {
    return {
      ...base,
      state: 'unsupported',
      error: typeof event.error === 'string' && event.error.trim()
        ? event.error.trim()
        : '当前版本不支持应用内更新。',
    };
  }

  return {
    ...base,
    state: 'idle',
    error: undefined,
  };
}

module.exports = {
  initialUpdateState,
  normalizeReleaseNotes,
  reduceUpdateState,
};
