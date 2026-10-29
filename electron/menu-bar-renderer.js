const api = window.piMenuBarApi;
const runningList = document.querySelector('#running-list');
const recentList = document.querySelector('#recent-list');
const summary = document.querySelector('#summary');
const runningCount = document.querySelector('#running-count');
const clearRecent = document.querySelector('#clear-recent');

let currentState = { running: [], recent: [], unreadCount: 0, theme: 'system' };

function workspaceName(cwd) {
  if (!cwd) return 'Pi Studio';
  return cwd.split('/').filter(Boolean).at(-1) || cwd;
}

function elapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(startedAt || Date.now())) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp || Date.now())) / 1000));
  if (seconds < 20) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

function applyTheme(theme) {
  const resolved = theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : theme;
  document.documentElement.dataset.theme = resolved;
}

function emptyState(title, detail) {
  const row = document.createElement('div');
  row.className = 'empty-state';
  const mark = document.createElement('span');
  mark.className = 'empty-mark';
  mark.textContent = 'π';
  const copy = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = title;
  const small = document.createElement('small');
  small.textContent = detail;
  copy.append(strong, small);
  row.append(mark, copy);
  return row;
}

function card(item, kind) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `session-card is-${kind === 'running' ? 'running' : item.status || 'success'}`;
  button.title = item.title;
  button.addEventListener('click', () => api.openSession({
    id: item.id,
    cwd: item.cwd,
    title: item.title,
  }));

  const orb = document.createElement('span');
  orb.className = 'status-orb';
  orb.setAttribute('aria-hidden', 'true');

  const copy = document.createElement('span');
  copy.className = 'session-copy';
  const title = document.createElement('strong');
  title.textContent = item.title || '会话';
  const detail = document.createElement('small');
  detail.dataset.cwd = item.cwd || '';
  if (kind === 'running') {
    detail.dataset.startedAt = String(item.startedAt || Date.now());
    detail.textContent = `${workspaceName(item.cwd)} · 已运行 ${elapsed(item.startedAt)}`;
  } else {
    const status = item.status === 'error' ? '需要查看' : item.status === 'cancelled' ? '已取消' : '已完成';
    detail.dataset.completedAt = String(item.completedAt || Date.now());
    detail.dataset.status = status;
    detail.textContent = `${workspaceName(item.cwd)} · ${status} · ${relativeTime(item.completedAt)}`;
  }
  copy.append(title, detail);

  const action = document.createElement('span');
  action.className = 'session-action';
  action.setAttribute('aria-hidden', 'true');
  action.textContent = '›';

  button.append(orb, copy, action);
  if (kind !== 'running' && item.unread) {
    const unread = document.createElement('i');
    unread.className = 'unread-dot';
    unread.setAttribute('aria-label', '新完成');
    button.append(unread);
  }
  return button;
}

function render() {
  applyTheme(currentState.theme);
  const running = Array.isArray(currentState.running) ? currentState.running : [];
  const recent = Array.isArray(currentState.recent) ? currentState.recent : [];
  runningCount.textContent = String(running.length);
  summary.textContent = running.length
    ? `${running.length} 个会话正在运行`
    : recent[0]
      ? `最近完成：${recent[0].title}`
      : '关闭窗口后仍会继续运行';

  runningList.replaceChildren(
    ...(running.length
      ? running.map(item => card(item, 'running'))
      : [emptyState('后台很安静', '从 Pi Studio 发送任务后，这里会显示实时状态。')]),
  );
  recentList.replaceChildren(
    ...(recent.length
      ? recent.map(item => card(item, 'recent'))
      : [emptyState('还没有完成记录', '任务结束后会在这里留下一个入口。')]),
  );
  clearRecent.disabled = recent.length === 0;
}

function updateElapsed() {
  for (const node of document.querySelectorAll('[data-started-at]')) {
    node.textContent = `${workspaceName(node.dataset.cwd)} · 已运行 ${elapsed(node.dataset.startedAt)}`;
  }
  for (const node of document.querySelectorAll('[data-completed-at]')) {
    node.textContent = `${workspaceName(node.dataset.cwd)} · ${node.dataset.status || '已完成'} · ${relativeTime(node.dataset.completedAt)}`;
  }
}

document.querySelector('#close').addEventListener('click', () => api.hide());
document.querySelector('#open-main').addEventListener('click', () => api.openMain());
clearRecent.addEventListener('click', () => api.clearRecent());
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.hide();
});

api.onState((next) => {
  currentState = next;
  render();
});
setInterval(updateElapsed, 1000);

api.state().then((next) => {
  currentState = next || currentState;
  render();
}).catch(() => render());
