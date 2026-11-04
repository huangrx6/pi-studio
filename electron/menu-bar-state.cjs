/**
 * 菜单栏展示状态的纯数据层。
 *
 * Electron 的 Tray / BrowserWindow 只消费这里的结果，使运行会话、
 * 完成记录和未读状态可以脱离窗口生命周期单独测试。
 */

const DEFAULT_RECENT_LIMIT = 4;

function cleanTitle(value, fallback = '新会话') {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return (text || fallback).slice(0, 96);
}

/** A completion should interrupt the user only when the app is not already in front. */
function shouldPresentBackgroundNotification(mainWindow) {
  if (!mainWindow || typeof mainWindow !== 'object') return true;
  try {
    if (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed()) return true;
    if (typeof mainWindow.isVisible === 'function' && !mainWindow.isVisible()) return true;
    if (typeof mainWindow.isFocused === 'function') return !mainWindow.isFocused();
  } catch {
    return true;
  }
  return true;
}

function createMenuBarState({ now = () => Date.now(), recentLimit = DEFAULT_RECENT_LIMIT } = {}) {
  const running = new Map();
  let recent = [];

  function start(input = {}) {
    if (typeof input.id !== 'string' || !input.id) throw new Error('会话参数无效');
    const existing = running.get(input.id);
    const session = {
      id: input.id,
      title: cleanTitle(input.title),
      cwd: typeof input.cwd === 'string' ? input.cwd : '',
      requestId: typeof input.requestId === 'string' ? input.requestId : '',
      startedAt: existing?.startedAt || now(),
      attention: undefined,
    };
    running.set(input.id, session);
    // A session that runs again supersedes its earlier completion: keeping both
    // would show the same conversation as "running" and "finished" at once.
    recent = recent.filter(item => item.id !== session.id);
    return { ...session };
  }

  function updateTitle(id, title) {
    const session = running.get(id);
    if (!session) return false;
    session.title = cleanTitle(title, session.title);
    return true;
  }

  function finish(input = {}) {
    const session = running.get(input.id);
    if (!session) return undefined;
    running.delete(input.id);
    const completed = {
      ...session,
      title: cleanTitle(input.title, session.title),
      completedAt: now(),
      status: input.status === 'error' ? 'error' : input.status === 'cancelled' ? 'cancelled' : 'success',
      unread: input.status !== 'cancelled',
    };
    recent = [completed, ...recent.filter(item => item.id !== completed.id)].slice(0, recentLimit);
    return { ...completed };
  }

  function setAttention(input = {}) {
    const session = running.get(input.id);
    if (!session) return false;
    session.attention = {
      kind: input.kind === 'input' ? 'input' : 'approval',
      label: cleanTitle(input.label, input.kind === 'input' ? '等待输入' : '等待授权'),
    };
    return true;
  }

  function clearAttention(id) {
    const session = running.get(id);
    if (!session?.attention) return false;
    session.attention = undefined;
    return true;
  }

  function markSeen(id) {
    const index = recent.findIndex(item => item.id === id && item.unread);
    if (index < 0) return false;
    recent = recent.map((item, itemIndex) => itemIndex === index ? { ...item, unread: false } : item);
    return true;
  }

  function clearRecent() {
    const changed = recent.length > 0;
    recent = [];
    return changed;
  }

  function snapshot(extra = {}) {
    // Guard the projection as well: a late completion event must never leave a
    // record in "recent" for a session that is running again.
    const visibleRecent = recent.filter(item => !running.has(item.id));
    return {
      running: [...running.values()]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(item => ({ ...item })),
      attention: [...running.values()]
        .filter(item => item.attention)
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(item => ({ ...item })),
      recent: visibleRecent.map(item => ({ ...item })),
      unreadCount: visibleRecent.filter(item => item.unread).length,
      ...extra,
    };
  }

  return { start, updateTitle, finish, setAttention, clearAttention, markSeen, clearRecent, snapshot };
}

/** Keep the popover compact when idle; only the list scrolls when busy. */
function menuBarPopoverHeight({ attention = [], running = [], recent = [] } = {}) {
  const attentionIds = new Set(attention.map(item => item.id));
  const visibleRunning = running.filter(item => !attentionIds.has(item.id));
  const groups = [attention, visibleRunning, recent].filter(items => items.length > 0);
  const rows = groups.reduce((total, items) => total + items.length, 0);
  if (rows === 0) return 148;
  // Header and footer stay fixed; section headings and rows determine only the
  // scrollable middle. Long queues cap before they can cover the desktop.
  return Math.min(480, 120 + groups.length * 24 + Math.max(0, groups.length - 1) * 6 + rows * 54);
}

module.exports = { menuBarPopoverHeight, createMenuBarState, cleanTitle, shouldPresentBackgroundNotification };
