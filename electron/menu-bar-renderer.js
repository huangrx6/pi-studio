const api = window.piMenuBarApi;
const attentionList = document.querySelector('#attention-list');
const runningList = document.querySelector('#running-list');
const recentList = document.querySelector('#recent-list');
const empty = document.querySelector('#empty');
const status = document.querySelector('#status');
const more = document.querySelector('#more');
const moreMenu = document.querySelector('#more-menu');
const clearRecent = document.querySelector('#clear-recent');

const DEFAULT_RADII = { tag: 4, control: 8, card: 12, panel: 16, round: 999 };
let currentState = {
  attention: [],
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

function elapsed(startedAt, endedAt) {
  const seconds = Math.max(0, Math.floor((Number(endedAt || Date.now()) - Number(startedAt || Date.now())) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
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
    if (Number.isFinite(value)) document.documentElement.style.setProperty(`--radius-${key}`, `${Math.max(0, value)}px`);
  }
}

function icon(kind, item) {
  const paths = kind === 'attention'
    ? '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3h.01"/>'
    : kind === 'running'
      ? '<path d="M20 12a8 8 0 1 1-8-8"/>'
      : item.status === 'error'
        ? '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3h.01"/>'
        : item.status === 'cancelled'
          ? '<path d="m7 7 10 10M17 7 7 17"/>'
          : '<path d="m5 12 4 4L19 6"/>';
  const node = document.createElement('span');
  node.className = 'status-icon';
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = `<svg viewBox="0 0 24 24">${paths}</svg>`;
  return node;
}

function detail(item, kind) {
  const workspace = workspaceName(item.cwd);
  if (kind === 'attention') return `${workspace} · ${item.attention?.label || '等待处理'}`;
  if (kind === 'running') return `${workspace} · 运行 ${elapsed(item.startedAt)}`;
  const state = item.status === 'error' ? '需要查看' : item.status === 'cancelled' ? '已停止' : '已完成';
  return `${workspace} · ${state} · ${relativeTime(item.completedAt)}`;
}

function sessionRow(item, kind) {
  const row = document.createElement('article');
  row.className = `session-row is-${kind === 'recent' ? item.status || 'success' : kind}`;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'session-open';
  open.title = item.title;
  open.setAttribute('aria-label', `打开会话：${item.title}`);
  open.addEventListener('click', () => api.openSession({ id: item.id, cwd: item.cwd, title: item.title }));

  const copy = document.createElement('span');
  copy.className = 'session-copy';
  const title = document.createElement('strong');
  title.textContent = item.title || '会话';
  const meta = document.createElement('small');
  meta.dataset.kind = kind;
  meta.dataset.cwd = item.cwd || '';
  meta.dataset.startedAt = String(item.startedAt || Date.now());
  meta.dataset.status = item.status || '';
  meta.dataset.completedAt = String(item.completedAt || '');
  meta.dataset.attentionLabel = item.attention?.label || '';
  meta.textContent = detail(item, kind);
  copy.append(title, meta);
  open.append(icon(kind, item), copy);
  row.append(open);

  if (kind === 'running' || kind === 'attention') {
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'session-stop';
    stop.title = '停止本轮运行';
    stop.setAttribute('aria-label', `停止本轮运行：${item.title}`);
    stop.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>';
    stop.addEventListener('click', async () => {
      if (stop.disabled) return;
      stop.disabled = true;
      stop.classList.add('is-busy');
      stop.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-8-8"/></svg>';
      status.textContent = `正在停止 ${item.title}`;
      try {
        const result = await api.stopSession({ id: item.id, requestId: item.requestId });
        if (!result?.ok) throw new Error(result?.reason === 'stale-run' ? '该会话已经开始了新一轮运行' : '任务已经结束');
        status.textContent = `${item.title} 已停止`;
      } catch (error) {
        stop.disabled = false;
        stop.classList.remove('is-busy');
        stop.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>';
        status.textContent = error instanceof Error ? error.message : '停止失败，请重试';
      }
    });
    row.append(stop);
  }

  if (kind === 'recent' && item.unread) {
    const unread = document.createElement('i');
    unread.className = 'unread-dot';
    unread.setAttribute('aria-label', '未查看');
    row.append(unread);
  }
  return row;
}

function render() {
  applyAppearance(currentState);
  const attention = Array.isArray(currentState.attention) ? currentState.attention : [];
  const attentionIds = new Set(attention.map(item => item.id));
  const running = (Array.isArray(currentState.running) ? currentState.running : [])
    .filter(item => !attentionIds.has(item.id));
  const recent = Array.isArray(currentState.recent) ? currentState.recent : [];

  document.querySelector('#attention-section').hidden = attention.length === 0;
  document.querySelector('#running-section').hidden = running.length === 0;
  document.querySelector('#recent-section').hidden = recent.length === 0;
  empty.hidden = attention.length + running.length + recent.length > 0;
  attentionList.replaceChildren(...attention.map(item => sessionRow(item, 'attention')));
  runningList.replaceChildren(...running.map(item => sessionRow(item, 'running')));
  recentList.replaceChildren(...recent.map(item => sessionRow(item, 'recent')));
  clearRecent.disabled = recent.length === 0;
}

function closeMoreMenu({ restoreFocus = false } = {}) {
  moreMenu.hidden = true;
  more.setAttribute('aria-expanded', 'false');
  if (restoreFocus) more.focus();
}

function toggleMoreMenu() {
  const opening = moreMenu.hidden;
  if (!opening) {
    closeMoreMenu({ restoreFocus: true });
    return;
  }
  moreMenu.hidden = false;
  more.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => moreMenu.querySelector('button:not(:disabled)')?.focus());
}

more.addEventListener('click', toggleMoreMenu);
document.querySelector('#settings').addEventListener('click', () => {
  closeMoreMenu();
  api.openSettings();
});
document.querySelector('#check-updates').addEventListener('click', () => {
  closeMoreMenu();
  api.checkUpdates();
});
clearRecent.addEventListener('click', () => {
  api.clearRecent();
  closeMoreMenu();
});
document.querySelector('#quit').addEventListener('click', () => {
  closeMoreMenu();
  api.quit();
});
document.querySelector('#open-main').addEventListener('click', () => api.openMain());

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.more-anchor')) closeMoreMenu();
});
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!moreMenu.hidden) closeMoreMenu({ restoreFocus: true });
  else api.hide();
});

api.onState((next) => {
  currentState = next;
  render();
});

setInterval(() => {
  for (const meta of document.querySelectorAll('.session-copy small')) {
    meta.textContent = detail({
      cwd: meta.dataset.cwd,
      startedAt: meta.dataset.startedAt,
      completedAt: meta.dataset.completedAt,
      status: meta.dataset.status,
      attention: { label: meta.dataset.attentionLabel },
    }, meta.dataset.kind);
  }
}, 1_000);

api.state().then((next) => {
  currentState = next || currentState;
  render();
}).catch(() => render());
