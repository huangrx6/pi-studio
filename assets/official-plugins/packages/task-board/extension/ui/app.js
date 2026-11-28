import {
  closeActivePopover,
  isPopoverEventTarget,
  mountDatePicker,
  mountSelect,
  renderDateTriggerHtml,
  renderSelectTriggerHtml,
} from './controls.js';

const PROTOCOL = 'pi-studio:ext-view:v1';
const PAGE_SIZE = 48;
const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
const STATUS_LABELS = { todo: '待办', in_progress: '进行中', blocked: '受阻', done: '已完成' };
const PRIORITY_LABELS = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const TYPES = ['feature', 'bug', 'improvement', 'chore'];
const TYPE_LABELS = { feature: '需求', bug: 'Bug', improvement: '优化', chore: '常规任务' };
const TYPE_SHORT = { feature: '需求', bug: 'Bug', improvement: '优化', chore: '常规' };
const ACTIVITY_LABELS = {
  created: '创建任务',
  status_changed: '状态变更',
  note: '进展记录',
  archived: '已归档',
  restored: '已恢复到看板',
  reopened: '重新打开',
};

const shortTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const shortDateFmt = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'numeric', day: 'numeric',
});

const state = {
  view: 'board', // 'board' | 'archive'
  typeFilter: '',
  projectFilter: '',
  boardDay: '',
  archiveSearch: '',
  archiveFrom: '',
  archiveTo: '',
  offset: 0,
  loading: true,
  invocable: false,
  error: '',
  actionError: '',
  snapshot: null,
  workspaces: [],
  menu: null, // { x, y, items }
  dragTaskId: null,
  editor: null, // { task, initialStatus, activities, loadingActivities, form, projectDraft, noteDraft, busy, error }
};

const pendingRequests = new Map();

function pad(n, len = 2) { return String(n).padStart(len, '0'); }
function localDay(date = new Date()) {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function localDateTimeInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function parseDateTimeInput(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error('请选择有效的本地日期和时间');
  return d.toISOString();
}
function currentWeekBounds() {
  const now = new Date();
  const weekday = now.getDay() === 0 ? 7 : now.getDay();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (weekday - 1));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { from: localDay(monday), to: localDay(sunday) };
}
function esc(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function post(message) {
  window.parent.postMessage({ protocol: PROTOCOL, ...message }, '*');
}

function invoke(method, params) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    post({ type: 'view:invoke', requestId, method, params });
  });
}

function buildQueryParams() {
  if (state.view === 'archive') {
    return {
      view: 'archive',
      archived: 'archived',
      dateField: 'actualEndAt',
      limit: PAGE_SIZE,
      offset: state.offset,
      ...(state.typeFilter ? { type: state.typeFilter } : {}),
      ...(state.projectFilter ? { project: state.projectFilter } : {}),
      ...(state.archiveSearch.trim() ? { search: state.archiveSearch.trim() } : {}),
      ...(state.archiveFrom ? { from: state.archiveFrom } : {}),
      ...(state.archiveTo ? { to: state.archiveTo } : {}),
    };
  }
  return {
    view: 'board',
    archived: 'active',
    dateField: 'createdAt',
    limit: PAGE_SIZE,
    offset: state.offset,
    ...(state.typeFilter ? { type: state.typeFilter } : {}),
    ...(state.projectFilter ? { project: state.projectFilter } : {}),
    ...(state.boardDay ? { from: state.boardDay, to: state.boardDay } : {}),
  };
}

function syncQuery() {
  post({ type: 'view:query', params: buildQueryParams() });
}

function allKnownProjects() {
  const map = new Map();
  for (const ws of state.workspaces) {
    if (ws?.name) map.set(ws.name.toLowerCase(), ws.name);
  }
  for (const name of state.snapshot?.allProjects ?? []) {
    if (name && !map.has(name.toLowerCase())) map.set(name.toLowerCase(), name);
  }
  return [...map.values()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function openTemporarySummary(kind) {
  const today = localDay();
  const week = currentWeekBounds();
  const projectNote = state.projectFilter ? `，重点聚焦关联项目「${state.projectFilter}」` : '';
  if (kind === 'daily') {
    post({
      type: 'view:openTemporaryChat',
      title: `今日日报 ${today}`,
      autoSubmit: true,
      prompt: `请调用 task_board_summary（from="${today}", to="${today}"${state.projectFilter ? `, project="${state.projectFilter}"` : ''}）梳理我今天的任务看板记录${projectNote}，并按「今日完成 / 今日推进 / 当前阻塞 / 明日计划」格式整理成一份清晰简洁的中文日报（注明涉及的关联项目，不编造未记录内容）。`,
    });
    return;
  }
  if (kind === 'weekly') {
    post({
      type: 'view:openTemporaryChat',
      title: `本周周报`,
      autoSubmit: true,
      prompt: `请调用 task_board_summary（from="${week.from}", to="${week.to}"${state.projectFilter ? `, project="${state.projectFilter}"` : ''}）梳理我本周（${week.from} 至 ${week.to}）的任务看板记录${projectNote}，按「本周成果（按需求/Bug修复/优化/常规任务分类，同一任务去重）/ 跨天推进（合并多天进展）/ 仍待解决的问题 / 下周计划」格式生成一份中文周报，并标注多项目对接任务的关联项目。`,
    });
    return;
  }
  post({
    type: 'view:openTemporaryChat',
    title: '任务梳理与总结',
    autoSubmit: false,
    prompt: `请调用 task_board_summary 帮我梳理 ${week.from} 至 ${today} 的任务进展${projectNote}。\n补充要求（可修改时间、项目或口吻）：`,
  });
}

function openEditor(task, initialStatus = 'todo') {
  const ed = {
    task: task || null,
    initialStatus,
    activities: [],
    loadingActivities: Boolean(task),
    busy: false,
    error: '',
    projectDraft: '',
    noteDraft: '',
    form: {
      title: task?.title ?? '',
      details: task?.details ?? '',
      type: task?.type ?? 'chore',
      status: task?.status ?? initialStatus,
      priority: task?.priority ?? 'normal',
      projects: [...(task?.projects ?? [])],
      plannedStartAt: localDateTimeInput(task?.plannedStartAt),
      plannedEndAt: localDateTimeInput(task?.plannedEndAt),
      actualStartAt: localDateTimeInput(task?.actualStartAt),
      actualEndAt: localDateTimeInput(task?.actualEndAt),
    },
  };
  state.editor = ed;
  renderEditorBody();
  const dialog = document.getElementById('tb-editor-dialog');
  if (!dialog.open) dialog.showModal();
  document.getElementById(task ? 'tb-editor-heading' : 'tb-ed-title').focus({ preventScroll: true });
  if (task?.id) {
    void invoke('getTaskDetail', { id: task.id })
      .then((detail) => {
        if (state.editor !== ed) return;
        if (detail.task.revision >= ed.task.revision) {
          ed.task = detail.task;
          ed.activities = detail.activities || [];
        }
        ed.loadingActivities = false;
        renderEditorBody();
      })
      .catch(() => {
        if (state.editor !== ed) return;
        ed.loadingActivities = false;
        renderEditorBody();
      });
  }
}

function closeEditor() {
  closeActivePopover();
  editorBodyObserver.disconnect();
  const dialog = document.getElementById('tb-editor-dialog');
  if (dialog?.open) dialog.close();
  dialog?.replaceChildren();
  state.editor = null;
}

function activityText(item) {
  if (item.kind === 'note') return item.body;
  if (item.kind === 'created') return `创建任务（${STATUS_LABELS[item.toStatus] || '待办'}）`;
  if (item.kind === 'status_changed') return `${STATUS_LABELS[item.fromStatus] || ''} → ${STATUS_LABELS[item.toStatus] || ''}`;
  if (item.kind === 'reopened') return `重新打开（${STATUS_LABELS[item.toStatus] || '进行中'}）`;
  return ACTIVITY_LABELS[item.kind] || item.kind;
}

async function saveEditorForm() {
  const ed = state.editor;
  if (!ed || ed.busy) return;
  const title = ed.form.title.trim();
  if (!title) {
    ed.error = missingTitle;
    renderEditorBody();
    document.getElementById('tb-ed-title')?.focus();
    return;
  }
  ed.busy = true;
  ed.error = '';
  renderEditorBody();
  try {
    const fields = {
      title,
      details: ed.form.details.trim(),
      type: ed.form.type,
      status: ed.form.status,
      priority: ed.form.priority,
      projects: ed.form.projects,
      plannedStartAt: parseDateTimeInput(ed.form.plannedStartAt),
      plannedEndAt: parseDateTimeInput(ed.form.plannedEndAt),
      actualStartAt: parseDateTimeInput(ed.form.actualStartAt),
      actualEndAt: parseDateTimeInput(ed.form.actualEndAt),
    };
    if (ed.task) {
      await invoke('updateTask', { id: ed.task.id, revision: ed.task.revision, fields });
    } else {
      await invoke('createTask', { id: crypto.randomUUID(), fields });
    }
    if (state.editor === ed) closeEditor();
  } catch (err) {
    ed.error = err instanceof Error ? err.message : String(err);
    ed.busy = false;
    if (state.editor === ed) renderEditorBody();
  }
}

async function addEditorNote() {
  const ed = state.editor;
  if (!ed?.task || ed.busy) return;
  const body = ed.noteDraft.trim();
  if (!body) return;
  ed.busy = true;
  ed.error = '';
  renderEditorBody();
  try {
    const res = await invoke('addNote', { taskId: ed.task.id, body });
    ed.task = res.task;
    ed.activities = res.activities || [];
    ed.noteDraft = '';
  } catch (err) {
    ed.error = err instanceof Error ? err.message : String(err);
  } finally {
    ed.busy = false;
    if (state.editor === ed) renderEditorBody();
  }
}

async function deleteEditorNote(activityId) {
  const ed = state.editor;
  if (!ed?.task || ed.busy) return;
  ed.busy = true;
  ed.error = '';
  renderEditorBody();
  try {
    const res = await invoke('deleteNote', { taskId: ed.task.id, activityId });
    ed.task = res.task;
    ed.activities = res.activities || [];
  } catch (err) {
    ed.error = err instanceof Error ? err.message : String(err);
  } finally {
    ed.busy = false;
    if (state.editor === ed) renderEditorBody();
  }
}

async function runLifecycleAction(method, task) {
  const ed = state.editor;
  state.actionError = '';
  try {
    const res = await invoke(method, { id: task.id, revision: task.revision });
    if (state.editor === ed && ed?.task?.id === task.id && res?.task) {
      ed.task = res.task;
      ed.form.status = res.task.status;
      ed.form.actualStartAt = localDateTimeInput(res.task.actualStartAt);
      ed.form.actualEndAt = localDateTimeInput(res.task.actualEndAt);
      const detail = await invoke('getTaskDetail', { id: res.task.id });
      if (state.editor !== ed) return;
      ed.task = detail.task;
      ed.activities = detail.activities || [];
      renderEditorBody();
    }
  } catch (err) {
    state.actionError = err instanceof Error ? err.message : String(err);
    render();
  }
}

async function handleBatchArchiveDone() {
  const doneCount = state.snapshot?.counts?.doneActive ?? 0;
  if (!doneCount) return;
  state.actionError = '';
  try {
    const res = await invoke('archiveDone', {});
    post({ type: 'view:notify', tone: 'success', message: `已归档 ${res.archivedCount} 项已完成任务` });
  } catch (err) {
    state.actionError = err instanceof Error ? err.message : String(err);
    render();
  }
}

async function moveCard(taskId, targetStatus) {
  const task = (state.snapshot?.tasks ?? []).find((t) => t.id === taskId);
  if (!task || task.status === targetStatus || !state.invocable) return;
  state.actionError = '';
  try {
    await invoke('updateTask', { id: task.id, revision: task.revision, fields: { status: targetStatus } });
  } catch (err) {
    state.actionError = err instanceof Error ? err.message : String(err);
    render();
  }
}

function showMenu(anchorEl, items) {
  closeActivePopover();
  const rect = anchorEl.getBoundingClientRect();
  state.menu = {
    x: Math.min(rect.left, Math.max(8, window.innerWidth - 210)),
    y: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - items.length * 36 - 16)),
    items,
  };
  renderMenu();
}

function closeMenu() {
  if (!state.menu) return;
  state.menu = null;
  renderMenu();
}

function renderMenu() {
  const existing = document.getElementById('tb-floating-menu');
  if (existing) existing.remove();
  if (!state.menu) return;
  const menu = document.createElement('div');
  menu.id = 'tb-floating-menu';
  menu.className = 'tb-menu';
  menu.setAttribute('role', 'menu');
  menu.style.left = `${state.menu.x}px`;
  menu.style.top = `${state.menu.y}px`;
  for (const item of state.menu.items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    if (item.danger) btn.className = 'is-danger';
    if (item.disabled) btn.disabled = true;
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      closeMenu();
      item.run();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
}

function renderCardHtml(task) {
  const planned = task.plannedEndAt || task.plannedStartAt;
  const projectsHtml = (task.projects || [])
    .map((p) => `<span class="tb-project-tag" title="${esc(p)}">${esc(p)}</span>`)
    .join('');
  return `
    <article class="tb-card" draggable="${state.invocable ? 'true' : 'false'}" data-task-id="${esc(task.id)}">
      <div class="tb-card-top">
        <button type="button" class="tb-card-title" data-action="edit" data-id="${esc(task.id)}">${esc(task.title)}</button>
        ${task.status === 'done'
          ? `<button type="button" class="tb-icon-btn" data-action="card-menu" data-id="${esc(task.id)}" aria-label="更多操作" title="更多操作">···</button>`
          : ''}
      </div>
      ${task.details ? `<p class="tb-card-details">${esc(task.details)}</p>` : ''}
      ${task.latestNote ? `<p class="tb-card-note" title="${esc(task.latestNote)}">${esc(task.latestNote)}</p>` : ''}
      <div class="tb-card-tags">
        <span class="tb-type-tag" data-type="${esc(task.type)}">${esc(TYPE_SHORT[task.type] || '常规')}</span>
        ${projectsHtml}
      </div>
      <div class="tb-card-meta">
        <span class="tb-priority-tag" data-priority="${esc(task.priority)}">${esc(PRIORITY_LABELS[task.priority] || '普通')}</span>
        <span>${planned ? esc(shortTimeFmt.format(new Date(planned))) : (task.actualEndAt && task.status === 'done' ? `完成于 ${esc(shortTimeFmt.format(new Date(task.actualEndAt)))}` : '')}</span>
      </div>
    </article>
  `;
}

function renderBoardBody() {
  const snap = state.snapshot;
  const today = localDay();
  const projects = allKnownProjects();
  const counts = snap?.counts ?? { active: 0, doneActive: 0, archived: 0 };
  const hasFilters = Boolean(state.typeFilter || state.projectFilter || state.boardDay);

  const projectOptions = [
    { value: '', label: '全部项目' },
    ...projects.map((p) => ({ value: p, label: p })),
  ];

  const filterBar = `
    <div class="tb-filters">
      <div class="tb-pills" role="group" aria-label="按类型筛选">
        <button type="button" class="tb-pill" data-filter-type="" aria-pressed="${!state.typeFilter}">全部</button>
        ${TYPES.map((t) => `<button type="button" class="tb-pill" data-filter-type="${t}" aria-pressed="${state.typeFilter === t}">${esc(TYPE_SHORT[t])}</button>`).join('')}
      </div>
      ${renderSelectTriggerHtml({
        id: 'tb-project-filter',
        label: '按关联项目筛选',
        value: state.projectFilter,
        placeholder: '全部项目',
        options: projectOptions,
      })}
      <div class="tb-segments" role="group" aria-label="按创建日期筛选">
        <button type="button" data-board-day="" aria-pressed="${!state.boardDay}">全部</button>
        <button type="button" data-board-day="${today}" aria-pressed="${state.boardDay === today}">今天</button>
      </div>
      ${renderDateTriggerHtml({
        id: 'tb-board-date',
        label: '创建日期',
        value: state.boardDay,
        placeholder: '选择日期',
      })}
    </div>
  `;

  if (state.loading && !snap) {
    return `${filterBar}<div class="tb-empty"><p>正在读取任务…</p></div>`;
  }

  if (snap && snap.total === 0) {
    return `
      ${filterBar}
      <div class="tb-empty">
        <h3>${hasFilters ? '当前筛选下没有任务' : '还没有任务'}</h3>
        <p>${hasFilters ? '可以切换类型、项目或日期条件后再看看。' : '点击右上角「新增任务」开始记录，新建时只填标题即可保存。'}</p>
        ${hasFilters
          ? '<button type="button" class="tb-subtle-btn" data-action="reset-board-filters">查看全部任务</button>'
          : `<button type="button" class="tb-primary-btn" data-action="new-task" ${!state.invocable ? 'disabled' : ''}>+ 新增任务</button>`}
      </div>
    `;
  }

  const tasks = snap?.tasks ?? [];
  const columnsHtml = STATUSES.map((status) => {
    const cards = tasks.filter((t) => t.status === status);
    return `
      <section class="tb-column" data-status="${status}" data-testid="column-${status}">
        <header class="tb-column-header">
          <span class="tb-status-dot" aria-hidden="true"></span>
          <h3>${esc(STATUS_LABELS[status])}</h3>
          <span class="tb-column-count">${cards.length}</span>
          <div class="tb-column-actions">
            ${status === 'done' && counts.doneActive > 0
              ? `<button type="button" class="tb-icon-btn" data-action="archive-done" title="批量归档已完成任务（${counts.doneActive} 项）" aria-label="批量归档已完成任务">📥</button>`
              : ''}
            <button type="button" class="tb-icon-btn" data-action="add-in-column" data-status="${status}" title="新增${esc(STATUS_LABELS[status])}任务" aria-label="新增${esc(STATUS_LABELS[status])}任务" ${!state.invocable ? 'disabled' : ''}>+</button>
          </div>
        </header>
        <div class="tb-cards" data-drop-status="${status}">
          ${cards.map(renderCardHtml).join('')}
        </div>
      </section>
    `;
  }).join('');

  return `${filterBar}<div class="tb-board-scroll"><div class="tb-columns">${columnsHtml}</div></div>${renderPagination(snap)}`;
}

function renderArchiveBody() {
  const snap = state.snapshot;
  const projects = allKnownProjects();
  const hasFilters = Boolean(state.archiveSearch.trim() || state.typeFilter || state.projectFilter || state.archiveFrom || state.archiveTo);
  const projectOptions = [
    { value: '', label: '全部项目' },
    ...projects.map((p) => ({ value: p, label: p })),
  ];
  const bar = `
    <div class="tb-archive-bar">
      <input type="search" class="tb-input tb-archive-search" id="tb-archive-search" aria-label="搜索归档任务" placeholder="按标题、详情或项目搜索归档…" value="${esc(state.archiveSearch)}" />
      <div class="tb-pills" role="group" aria-label="按类型筛选归档">
        <button type="button" class="tb-pill" data-filter-type="" aria-pressed="${!state.typeFilter}">全部</button>
        ${TYPES.map((t) => `<button type="button" class="tb-pill" data-filter-type="${t}" aria-pressed="${state.typeFilter === t}">${esc(TYPE_SHORT[t])}</button>`).join('')}
      </div>
      ${renderSelectTriggerHtml({
        id: 'tb-project-filter',
        label: '按项目筛选归档',
        value: state.projectFilter,
        placeholder: '全部项目',
        options: projectOptions,
      })}
      ${renderDateTriggerHtml({
        id: 'tb-archive-from',
        label: '完成开始日期',
        value: state.archiveFrom,
        placeholder: '开始日期',
      })}
      <span style="color:var(--muted);font-size:var(--text-description)">至</span>
      ${renderDateTriggerHtml({
        id: 'tb-archive-to',
        label: '完成结束日期',
        value: state.archiveTo,
        placeholder: '结束日期',
      })}
      ${hasFilters ? '<button type="button" class="tb-subtle-btn" data-action="reset-archive-filters">重置</button>' : ''}
    </div>
  `;

  if (state.loading && !snap) {
    return `<div class="tb-archive">${bar}<div class="tb-empty"><p>正在读取归档…</p></div></div>`;
  }

  const tasks = snap?.tasks ?? [];
  if (!tasks.length) {
    return `
      <div class="tb-archive">
        ${bar}
        <div class="tb-empty">
          <h3>${hasFilters ? '没有匹配的归档任务' : '还没有归档任务'}</h3>
          <p>${hasFilters ? '调整标题、类型、项目或完成日期再试试。' : '拖入「已完成」的任务会先留在看板方便核对，整理时再从菜单或列标题归档。'}</p>
        </div>
      </div>
    `;
  }

  const rows = tasks.map((task) => `
    <li class="tb-archive-row">
      <div class="tb-archive-main">
        <div class="tb-archive-title-row">
          <span class="tb-type-tag" data-type="${esc(task.type)}">${esc(TYPE_LABELS[task.type] || '常规任务')}</span>
          <button type="button" class="tb-card-title" data-action="edit" data-id="${esc(task.id)}">${esc(task.title)}</button>
          ${(task.projects || []).map((p) => `<span class="tb-project-tag">${esc(p)}</span>`).join('')}
        </div>
        <div class="tb-archive-meta">
          ${task.actualEndAt ? `<span>完成于 ${esc(shortDateFmt.format(new Date(task.actualEndAt)))}</span>` : ''}
          ${task.archivedAt ? `<span>归档于 ${esc(shortDateFmt.format(new Date(task.archivedAt)))}</span>` : ''}
          ${task.latestNote ? `<span>最新进展：${esc(task.latestNote)}</span>` : ''}
        </div>
      </div>
      <div class="tb-archive-ops">
        <button type="button" class="tb-subtle-btn" data-action="restore" data-id="${esc(task.id)}" ${!state.invocable ? 'disabled' : ''}>恢复到看板</button>
        <button type="button" class="tb-subtle-btn" data-action="reopen" data-id="${esc(task.id)}" ${!state.invocable ? 'disabled' : ''}>重新打开</button>
      </div>
    </li>
  `).join('');

  return `<div class="tb-archive">${bar}<ul class="tb-archive-list">${rows}</ul>${renderPagination(snap)}</div>`;
}

function renderPagination(snap) {
  if (!snap || (state.offset === 0 && snap.nextOffset === null)) return '';
  const page = Math.floor(state.offset / PAGE_SIZE) + 1;
  return `
    <footer class="tb-pagination">
      <button type="button" class="tb-subtle-btn" data-action="prev-page" ${state.offset === 0 ? 'disabled' : ''}>上一页</button>
      <span>第 ${page} 页 · 共 ${snap.total} 项</span>
      <button type="button" class="tb-subtle-btn" data-action="next-page" ${snap.nextOffset === null ? 'disabled' : ''}>下一页</button>
    </footer>
  `;
}

const editorProperties = [
  { key: 'status', id: 'tb-ed-status', title: '状态', label: '任务状态', options: STATUSES.map(value => ({ value, label: STATUS_LABELS[value] })) },
  { key: 'priority', id: 'tb-ed-priority', title: '优先级', label: '优先级', options: Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label })) },
  { key: 'type', id: 'tb-ed-type', title: '类型', label: '任务类型', options: TYPES.map(value => ({ value, label: TYPE_LABELS[value] })) },
];
const editorDates = [
  { key: 'plannedStartAt', id: 'tb-ed-ps', label: '计划开始' },
  { key: 'plannedEndAt', id: 'tb-ed-pe', label: '计划结束' },
  { key: 'actualStartAt', id: 'tb-ed-as', label: '实际开始' },
  { key: 'actualEndAt', id: 'tb-ed-ae', label: '实际结束' },
];
const missingTitle = '请输入任务标题';
// Reserve the actual header, footer, feedback and padding when the sticky sidebar needs to scroll.
const editorBodyObserver = new ResizeObserver(([entry]) => {
  const body = entry.target;
  const chromeHeight = body.parentElement.getBoundingClientRect().height - entry.contentRect.height;
  body.closest('dialog')?.style.setProperty('--tb-editor-chrome-height', `${chromeHeight}px`);
});

function renderProjectFields(ed, expanded) {
  const selected = new Set(ed.form.projects.map(name => name.toLowerCase()));
  const suggestions = allKnownProjects().filter(name => !selected.has(name.toLowerCase()));
  return `
    <section class="tb-projects-box" aria-labelledby="tb-ed-projects-heading">
      <h3 class="tb-section-title" id="tb-ed-projects-heading">关联项目</h3>
      ${selected.size ? `<div class="tb-selected-projects">${ed.form.projects.map(name => `
        <span class="tb-chip"><span>${esc(name)}</span><button type="button" data-remove-project="${esc(name)}" aria-label="移除项目 ${esc(name)}">×</button></span>
      `).join('')}</div>` : ''}
      <div class="tb-project-input-row">
        <input type="text" class="tb-input" id="tb-ed-project-input" aria-label="项目或对接方名称" placeholder="输入项目或对接方名称" maxlength="80" value="${esc(ed.projectDraft)}" />
        <button type="button" class="tb-subtle-btn" id="tb-ed-project-add">添加</button>
      </div>
      ${suggestions.length ? `<details class="tb-project-options" ${expanded ? 'open' : ''}>
        <summary id="tb-ed-project-options">选择已有项目</summary>
        <div class="tb-project-suggestions">${suggestions.map(name =>
          `<button type="button" class="tb-suggest-chip" data-add-project="${esc(name)}">+ ${esc(name)}</button>`
        ).join('')}</div>
      </details>` : ''}
    </section>`;
}

function renderProgressSection(ed) {
  if (!ed.task) return '';
  return `
    <section class="tb-progress-section" aria-labelledby="tb-ed-progress-heading">
      <h3 class="tb-section-title" id="tb-ed-progress-heading">进展记录</h3>
      <div class="tb-note-row">
        <input type="text" class="tb-input" id="tb-ed-note" aria-label="新增进展" placeholder="记录最新进展…" maxlength="1000" value="${esc(ed.noteDraft)}" />
        <button type="button" class="tb-subtle-btn" id="tb-ed-note-submit" ${ed.busy ? 'disabled' : ''}>记录</button>
      </div>
      ${ed.loadingActivities || !ed.activities.length
        ? `<p class="tb-activity-empty">${ed.loadingActivities ? '正在读取记录…' : '暂无活动记录'}</p>`
        : `<ol class="tb-activity-list">${ed.activities.map(item => `
          <li class="tb-activity-item" data-kind="${esc(item.kind)}">
            <div class="tb-activity-text">
              <time datetime="${esc(item.createdAt)}">${esc(shortTimeFmt.format(new Date(item.createdAt)))}</time>
              <p>${esc(activityText(item))}</p>
            </div>
            ${item.kind === 'note' ? `<button type="button" class="tb-icon-btn" data-delete-note="${esc(item.id)}" title="删除进展记录" aria-label="删除进展记录">✕</button>` : ''}
          </li>`).join('')}</ol>`}
    </section>`;
}

function renderEditorBody() {
  const dialog = document.getElementById('tb-editor-dialog');
  const ed = state.editor;
  if (!ed) return;
  closeActivePopover();
  const scrolled = dialog.querySelector('.tb-dialog-body')?.scrollTop ?? 0;
  const metaScroll = dialog.querySelector('.tb-editor-meta')?.scrollTop ?? 0;
  const detailsScroll = dialog.querySelector('#tb-ed-details')?.scrollTop ?? 0;
  const projectsExpanded = dialog.querySelector('.tb-project-options')?.open ?? false;
  const active = dialog.contains(document.activeElement) ? document.activeElement : null;
  const focusId = active?.id || (active?.closest('.tb-projects-box') ? 'tb-ed-project-input' : '');
  const caret = active?.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;

  editorBodyObserver.disconnect();
  dialog.innerHTML = `
    <div class="tb-dialog-shell">
      <header class="tb-dialog-head">
        <h2 id="tb-editor-heading" tabindex="-1">${ed.task ? '编辑任务' : '新增任务'}</h2>
        <button type="button" class="tb-icon-btn" id="tb-ed-close" aria-label="关闭">✕</button>
      </header>
      <div class="tb-dialog-body">
        ${ed.task?.archivedAt ? `
          <div class="tb-archived-banner">
            <span>已于 ${esc(shortTimeFmt.format(new Date(ed.task.archivedAt)))} 归档</span>
            <div class="tb-archive-buttons">
              <button type="button" class="tb-subtle-btn" id="tb-ed-restore" ${ed.busy ? 'disabled' : ''}>恢复到看板</button>
              <button type="button" class="tb-subtle-btn" id="tb-ed-reopen" ${ed.busy ? 'disabled' : ''}>重新打开</button>
            </div>
          </div>` : ''}
        <div class="tb-editor-layout">
          <div class="tb-editor-content">
            <label class="tb-title-label" for="tb-ed-title">任务标题</label>
            <textarea class="tb-field-title" id="tb-ed-title" rows="1" required ${ed.error === missingTitle ? 'aria-invalid="true" aria-describedby="tb-ed-error"' : ''} placeholder="输入任务标题" maxlength="160">${esc(ed.form.title)}</textarea>
            <label class="tb-section-title" for="tb-ed-details">任务描述</label>
            <textarea class="tb-textarea" id="tb-ed-details" rows="4" placeholder="添加任务详情、背景或对接说明…" maxlength="4000">${esc(ed.form.details)}</textarea>
            ${renderProjectFields(ed, projectsExpanded)}
          </div>
          <div class="tb-editor-meta">
            <section class="tb-properties" aria-labelledby="tb-ed-props-heading">
              <h3 class="tb-section-title" id="tb-ed-props-heading">任务属性</h3>
              ${editorProperties.map(({ key, id, title, label, options }) => `
                <div class="tb-prop" data-field="${key}" data-value="${esc(ed.form[key])}">
                  <label for="${id}">${title}</label>
                  ${renderSelectTriggerHtml({ id, label, value: ed.form[key], options })}
                </div>`).join('')}
            </section>
            <section class="tb-schedule" aria-labelledby="tb-ed-schedule-heading">
              <h3 class="tb-section-title" id="tb-ed-schedule-heading">时间安排</h3>
              ${editorDates.map(({ key, id, label }) => `
                <div class="tb-prop">
                  <label for="${id}">${label}</label>
                  ${renderDateTriggerHtml({ id, label, value: ed.form[key], includeTime: true, placeholder: '选择时间' })}
                </div>`).join('')}
            </section>
          </div>
          ${renderProgressSection(ed)}
        </div>
      </div>
      ${ed.error ? `<div class="tb-feedback tb-editor-error" id="tb-ed-error" role="alert">${esc(ed.error)}</div>` : ''}
      <footer class="tb-dialog-foot">
        ${ed.task && !ed.task.archivedAt && ed.task.status === 'done'
          ? `<button type="button" class="tb-subtle-btn" id="tb-ed-archive" ${ed.busy ? 'disabled' : ''}>归档任务</button>` : ''}
        <div class="tb-dialog-foot-right">
          <button type="button" class="tb-subtle-btn" id="tb-ed-cancel">取消</button>
          <button type="button" class="tb-primary-btn" id="tb-ed-save" ${ed.busy ? 'disabled' : ''}>${ed.task ? '保存更改' : '新增任务'}</button>
        </div>
      </footer>
    </div>
  `;

  const body = dialog.querySelector('.tb-dialog-body');
  editorBodyObserver.observe(body);
  if (dialog.open) {
    const focusTarget = focusId && document.getElementById(focusId);
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
      if (caret && focusTarget.id === active.id) focusTarget.setSelectionRange(...caret);
    }
    body.scrollTop = scrolled;
    dialog.querySelector('.tb-editor-meta').scrollTop = metaScroll;
    dialog.querySelector('#tb-ed-details').scrollTop = detailsScroll;
  }

  const addProjectValue = (raw) => {
    const clean = String(raw || '').trim();
    if (!clean) return;
    if (!ed.form.projects.some((p) => p.toLowerCase() === clean.toLowerCase())) {
      ed.form.projects = [...ed.form.projects, clean];
    }
    ed.projectDraft = '';
    renderEditorBody();
  };

  dialog.querySelector('#tb-ed-close')?.addEventListener('click', closeEditor);
  dialog.querySelector('#tb-ed-cancel')?.addEventListener('click', closeEditor);
  dialog.querySelector('#tb-ed-save')?.addEventListener('click', () => void saveEditorForm());
  dialog.querySelector('#tb-ed-title').addEventListener('input', (e) => {
    ed.form.title = e.target.value;
    if (ed.error === missingTitle && ed.form.title.trim()) {
      ed.error = '';
      e.target.removeAttribute('aria-invalid');
      e.target.removeAttribute('aria-describedby');
      dialog.querySelector('#tb-ed-error')?.remove();
    }
  });
  dialog.querySelector('#tb-ed-details')?.addEventListener('input', (e) => { ed.form.details = e.target.value; });

  for (const { key, id, label, options } of editorProperties) {
    mountSelect(document.getElementById(id), {
      label, value: ed.form[key], options,
      onChange: value => { ed.form[key] = value; renderEditorBody(); },
    });
  }
  for (const { key, id, label } of editorDates) {
    mountDatePicker(document.getElementById(id), {
      label, value: ed.form[key], includeTime: true, placeholder: '选择时间',
      onChange: value => { ed.form[key] = value; },
    });
  }

  const projInput = dialog.querySelector('#tb-ed-project-input');
  projInput?.addEventListener('input', (e) => { ed.projectDraft = e.target.value; });
  projInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      addProjectValue(e.target.value);
    }
  });
  dialog.querySelector('#tb-ed-project-add')?.addEventListener('click', () => addProjectValue(ed.projectDraft));
  dialog.querySelectorAll('[data-add-project]').forEach((btn) => {
    btn.addEventListener('click', () => addProjectValue(btn.getAttribute('data-add-project')));
  });
  dialog.querySelectorAll('[data-remove-project]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-remove-project');
      ed.form.projects = ed.form.projects.filter((p) => p !== target);
      renderEditorBody();
    });
  });

  const noteInput = dialog.querySelector('#tb-ed-note');
  noteInput?.addEventListener('input', (e) => { ed.noteDraft = e.target.value; });
  noteInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void addEditorNote();
    }
  });
  dialog.querySelector('#tb-ed-note-submit')?.addEventListener('click', () => void addEditorNote());
  dialog.querySelectorAll('[data-delete-note]').forEach((btn) => {
    btn.addEventListener('click', () => void deleteEditorNote(btn.getAttribute('data-delete-note')));
  });

  dialog.querySelector('#tb-ed-archive')?.addEventListener('click', () => ed.task && void runLifecycleAction('archiveTask', ed.task));
  dialog.querySelector('#tb-ed-restore')?.addEventListener('click', () => ed.task && void runLifecycleAction('restoreTask', ed.task));
  dialog.querySelector('#tb-ed-reopen')?.addEventListener('click', () => ed.task && void runLifecycleAction('reopenTask', ed.task));
}

function render() {
  if (!state.editor) closeActivePopover();
  const root = document.getElementById('app');
  if (!root) return;
  const counts = state.snapshot?.counts ?? { active: 0, doneActive: 0, archived: 0 };
  const activeSearchEl = document.activeElement?.id === 'tb-archive-search';
  const searchSelectionStart = activeSearchEl ? document.activeElement.selectionStart : null;

  root.innerHTML = `
    <header class="tb-header">
      <div class="tb-header-left">
        <h2 class="tb-title">全局任务</h2>
        <div class="tb-segments" role="tablist" aria-label="任务视图">
          <button type="button" data-view="board" aria-pressed="${state.view === 'board'}">
            看板 <span class="tb-badge-count">${counts.active}</span>
          </button>
          <button type="button" data-view="archive" aria-pressed="${state.view === 'archive'}">
            归档 <span class="tb-badge-count">${counts.archived}</span>
          </button>
        </div>
      </div>
      <div class="tb-header-right">
        <button type="button" class="tb-subtle-btn" id="tb-ai-summary-btn">✦ AI 总结</button>
        ${state.view === 'board'
          ? `<button type="button" class="tb-primary-btn" data-action="new-task" ${!state.invocable ? 'disabled' : ''}>+ 新增任务</button>`
          : ''}
      </div>
    </header>
    ${state.error ? `<div class="tb-feedback" role="status"><span>无法读取任务看板：${esc(state.error)}</span><button type="button" class="tb-subtle-btn" data-action="retry">重试</button></div>` : ''}
    ${state.actionError ? `<div class="tb-feedback" role="alert"><span>${esc(state.actionError)}</span><button type="button" class="tb-icon-btn" data-action="clear-error">✕</button></div>` : ''}
    ${state.view === 'board' ? renderBoardBody() : renderArchiveBody()}
  `;

  if (activeSearchEl) {
    const input = document.getElementById('tb-archive-search');
    if (input) {
      input.focus();
      if (searchSelectionStart !== null) input.setSelectionRange(searchSelectionStart, searchSelectionStart);
    }
  }

  bindEvents(root);
}

let searchTimer;

function bindEvents(root) {
  root.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-view');
      if (next === state.view) return;
      state.view = next;
      state.offset = 0;
      closeMenu();
      syncQuery();
      render();
    });
  });

  root.querySelector('#tb-ai-summary-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showMenu(e.currentTarget, [
      { label: '临时会话 · 生成今日日报', run: () => openTemporarySummary('daily') },
      { label: '临时会话 · 生成本周周报', run: () => openTemporarySummary('weekly') },
      { label: '临时会话 · 自定义周期 / 项目梳理', run: () => openTemporarySummary('custom') },
    ]);
  });

  root.querySelectorAll('[data-action="new-task"]').forEach((btn) => {
    btn.addEventListener('click', () => openEditor(null, 'todo'));
  });
  root.querySelectorAll('[data-action="add-in-column"]').forEach((btn) => {
    btn.addEventListener('click', () => openEditor(null, btn.getAttribute('data-status') || 'todo'));
  });
  root.querySelector('[data-action="archive-done"]')?.addEventListener('click', () => void handleBatchArchiveDone());
  root.querySelector('[data-action="retry"]')?.addEventListener('click', () => post({ type: 'view:retry' }));
  root.querySelector('[data-action="clear-error"]')?.addEventListener('click', () => { state.actionError = ''; render(); });

  root.querySelectorAll('[data-filter-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-filter-type') || '';
      state.typeFilter = state.typeFilter === next ? '' : next;
      state.offset = 0;
      syncQuery();
      render();
    });
  });

  const projects = allKnownProjects();
  const projectOptions = [
    { value: '', label: '全部项目' },
    ...projects.map((p) => ({ value: p, label: p })),
  ];
  mountSelect(root.querySelector('#tb-project-filter'), {
    label: state.view === 'archive' ? '按项目筛选归档' : '按关联项目筛选',
    value: state.projectFilter,
    options: projectOptions,
    onChange: (value) => {
      state.projectFilter = value;
      state.offset = 0;
      syncQuery();
      render();
    },
  });

  root.querySelectorAll('[data-board-day]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.boardDay = btn.getAttribute('data-board-day') || '';
      state.offset = 0;
      syncQuery();
      render();
    });
  });

  mountDatePicker(root.querySelector('#tb-board-date'), {
    label: '创建日期',
    value: state.boardDay,
    placeholder: '选择日期',
    onChange: (value) => {
      state.boardDay = value;
      state.offset = 0;
      syncQuery();
      render();
    },
  });

  root.querySelector('#tb-archive-search')?.addEventListener('input', (e) => {
    state.archiveSearch = e.target.value;
    state.offset = 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(syncQuery, 180);
  });

  mountDatePicker(root.querySelector('#tb-archive-from'), {
    label: '完成开始日期',
    value: state.archiveFrom,
    max: state.archiveTo,
    placeholder: '开始日期',
    onChange: (value) => {
      state.archiveFrom = value;
      state.offset = 0;
      syncQuery();
      render();
    },
  });

  mountDatePicker(root.querySelector('#tb-archive-to'), {
    label: '完成结束日期',
    value: state.archiveTo,
    min: state.archiveFrom,
    placeholder: '结束日期',
    onChange: (value) => {
      state.archiveTo = value;
      state.offset = 0;
      syncQuery();
      render();
    },
  });

  root.querySelector('[data-action="reset-board-filters"]')?.addEventListener('click', () => {
    state.typeFilter = '';
    state.projectFilter = '';
    state.boardDay = '';
    state.offset = 0;
    syncQuery();
    render();
  });

  root.querySelector('[data-action="reset-archive-filters"]')?.addEventListener('click', () => {
    state.archiveSearch = '';
    state.typeFilter = '';
    state.projectFilter = '';
    state.archiveFrom = '';
    state.archiveTo = '';
    state.offset = 0;
    syncQuery();
    render();
  });

  root.querySelector('[data-action="prev-page"]')?.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - PAGE_SIZE);
    syncQuery();
  });

  root.querySelector('[data-action="next-page"]')?.addEventListener('click', () => {
    if (state.snapshot?.nextOffset != null) {
      state.offset = state.snapshot.nextOffset;
      syncQuery();
    }
  });

  const tasksById = new Map((state.snapshot?.tasks ?? []).map((t) => [t.id, t]));
  root.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const task = tasksById.get(btn.getAttribute('data-id'));
      if (task) openEditor(task, task.status);
    });
  });

  root.querySelectorAll('[data-action="restore"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const task = tasksById.get(btn.getAttribute('data-id'));
      if (task) void runLifecycleAction('restoreTask', task);
    });
  });

  root.querySelectorAll('[data-action="reopen"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const task = tasksById.get(btn.getAttribute('data-id'));
      if (task) void runLifecycleAction('reopenTask', task);
    });
  });

  root.querySelectorAll('[data-action="card-menu"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const task = tasksById.get(btn.getAttribute('data-id'));
      if (!task) return;
      showMenu(btn, [
        { label: '归档任务', run: () => void runLifecycleAction('archiveTask', task) },
        { label: '重新打开（进行中）', run: () => void runLifecycleAction('reopenTask', task) },
        { label: '编辑任务与进展', run: () => openEditor(task, task.status) },
      ]);
    });
  });

  // Native HTML5 Drag and Drop between Kanban columns
  root.querySelectorAll('.tb-card[draggable="true"]').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      state.dragTaskId = card.getAttribute('data-task-id');
      card.classList.add('is-dragging');
      e.dataTransfer?.setData('text/plain', state.dragTaskId || '');
    });
    card.addEventListener('dragend', () => {
      state.dragTaskId = null;
      card.classList.remove('is-dragging');
      root.querySelectorAll('.tb-column.is-drop-over').forEach((el) => el.classList.remove('is-drop-over'));
    });
  });

  root.querySelectorAll('.tb-column').forEach((column) => {
    const status = column.getAttribute('data-status');
    column.addEventListener('dragover', (e) => {
      if (!state.dragTaskId) return;
      e.preventDefault();
      column.classList.add('is-drop-over');
    });
    column.addEventListener('dragleave', (e) => {
      if (!column.contains(e.relatedTarget)) column.classList.remove('is-drop-over');
    });
    column.addEventListener('drop', (e) => {
      e.preventDefault();
      column.classList.remove('is-drop-over');
      const id = state.dragTaskId || e.dataTransfer?.getData('text/plain');
      if (id && status) void moveCard(id, status);
    });
  });
}

document.addEventListener('click', (e) => {
  if (!isPopoverEventTarget(e.target)) closeActivePopover();
  if (state.menu && !e.target?.closest?.('#tb-floating-menu')) closeMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (closeActivePopover(true)) { e.preventDefault(); return; }
    if (state.menu) closeMenu();
  }
});
document.getElementById('tb-editor-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  if (!closeActivePopover(true)) closeEditor();
});

let lastAppliedTokens = '';
let lastWorkspacesSignature = '';

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (event.source !== window.parent || msg?.protocol !== PROTOCOL) return;
  if (msg.type === 'host:context') {
    const nextTheme = msg.theme === 'dark' ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== nextTheme) {
      document.documentElement.dataset.theme = nextTheme;
      document.documentElement.style.colorScheme = nextTheme;
    }
    if (msg.tokens && typeof msg.tokens === 'object') {
      const nextTokensKey = JSON.stringify(msg.tokens);
      if (nextTokensKey !== lastAppliedTokens) {
        lastAppliedTokens = nextTokensKey;
        for (const [k, v] of Object.entries(msg.tokens)) {
          if (k.startsWith('--') && typeof v === 'string') document.documentElement.style.setProperty(k, v);
        }
      }
    }
    const nextWorkspaces = Array.isArray(msg.workspaces) ? msg.workspaces : [];
    const nextWsSig = JSON.stringify(nextWorkspaces.map((w) => [w?.name || '', w?.path || '']));
    const nextInvocable = msg.invocable === true;
    const structureChanged = nextInvocable !== state.invocable || nextWsSig !== lastWorkspacesSignature;
    state.workspaces = nextWorkspaces;
    state.invocable = nextInvocable;
    lastWorkspacesSignature = nextWsSig;
    if (structureChanged) render();
    return;
  }
  if (msg.type === 'host:snapshot') {
    state.loading = Boolean(msg.loading);
    state.error = msg.error || '';
    state.invocable = msg.invocable === true;
    if (msg.data) state.snapshot = msg.data;
    render();
    return;
  }
  if (msg.type === 'host:response') {
    const pending = pendingRequests.get(msg.requestId);
    if (!pending) return;
    pendingRequests.delete(msg.requestId);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error || '操作失败'));
  }
});

render();
post({ type: 'view:ready' });
syncQuery();
