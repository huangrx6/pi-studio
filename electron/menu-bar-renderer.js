const api = window.piMenuBarApi;
const runningList = document.querySelector('#running-list');
const recentList = document.querySelector('#recent-list');
const summary = document.querySelector('#summary');
const runningCount = document.querySelector('#running-count');

const clearRecent = document.querySelector('#clear-recent');

const DEFAULT_RADII = { tag: 4, control: 8, card: 12, panel: 16, round: 999 };
let currentState = {
  running: [],
  recent: [],
  unreadCount: 0,
  theme: 'system',
  palette: 'lime',
  radii: DEFAULT_RADII,
};

function workspaceName(cwd) {
  if (!cwd) return 'Pi Studio';
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
}

function elapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(startedAt || Date.now())) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp || Date.now())) / 1000));
  if (seconds < 20) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

function applyAppearance({ theme, palette, radii } = {}) {
  const resolved = theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.palette = palette || 'lime';
  const values = radii && typeof radii === 'object' ? { ...DEFAULT_RADII, ...radii } : DEFAULT_RADII;
  for (const key of ['tag', 'control', 'card', 'panel', 'round']) {
    const value = Number(values[key]);
    if (Number.isFinite(value)) {
      document.documentElement.style.setProperty(`--radius-${key}`, `${Math.max(0, value)}px`);
    }
  }
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
  // Fixed local paths only; session content is always inserted with textContent.
  const paths = kind === 'running' ? '<path d="M20 12a8 8 0 1 1-8-8"/>'
    : item.status === 'error' ? '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3h.01"/>'
    : item.status === 'cancelled' ? '<path d="m7 7 10 10M17 7 7 17"/>'
    : '<path d="m5 12 4 4L19 6"/>';
  orb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

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

  button.append(orb, copy);
  if (kind !== 'running' && item.unread) {
    const unread = document.createElement('i');
    unread.className = 'unread-dot';
    unread.setAttribute('aria-label', '新完成');
    button.append(unread);
  }
  button.append(action);
  return button;
}

function render() {
  applyAppearance(currentState);
  const running = Array.isArray(currentState.running) ? currentState.running : [];
  const recent = Array.isArray(currentState.recent) ? currentState.recent : [];
  const errors = recent.filter(item => item.status === 'error').length;
  runningCount.textContent = String(running.length);
  summary.textContent = running.length
    ? `${running.length} 个会话运行中${errors ? ` · ${errors} 个异常待查看` : ' · 关闭窗口后仍会继续'}`
    : errors ? `${errors} 个会话异常，点击查看详情`
    : recent.length ? '后台会话已结束，点击查看结果' : '暂无后台会话，可回到应用开始对话';
  document.querySelector('#running-section').hidden = running.length === 0;
  document.querySelector('#recent-section').hidden = recent.length === 0;
  runningList.replaceChildren(...running.map(item => card(item, 'running')));
  recentList.replaceChildren(...recent.map(item => card(item, 'recent')));
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

document.querySelector('#quit').addEventListener('click', () => api.quit());
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
