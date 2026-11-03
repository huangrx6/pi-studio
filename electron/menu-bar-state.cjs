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

  function markSeen() {
    let changed = false;
    recent = recent.map((item) => {
      if (!item.unread) return item;
      changed = true;
      return { ...item, unread: false };
    });
    return changed;
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
      recent: visibleRecent.map(item => ({ ...item })),
      unreadCount: visibleRecent.filter(item => item.unread).length,
      ...extra,
    };
  }

  return { start, updateTitle, finish, markSeen, clearRecent, snapshot };
}

/** Keep the popover compact when idle; only the list scrolls when busy. */
function menuBarPopoverHeight({ running = [], recent = [] } = {}) {
  const sections = Number(running.length > 0) + Number(recent.length > 0);
  // 168 covers the chrome (header, summary, footer, panel and shell insets);
  // every section adds its heading and every card adds a row. The rows are sized
  // for the longest detail line, so a freshly finished session never clips.
  return Math.max(196, Math.min(440, 168 + sections * 28
    + (sections > 1 ? 8 : 0) + (running.length + recent.length) * 56));
}

module.exports = { menuBarPopoverHeight, createMenuBarState, cleanTitle, shouldPresentBackgroundNotification };
