const CHEVRON_DOWN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CALENDAR_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>';
const CHEVRON_LEFT_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const CHEVRON_RIGHT_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const CLOCK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

let activePopover = null; // { el, anchor, onClose }

function esc(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

export function todayIsoDay(now = new Date()) {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function parseIsoDay(value) {
  const m = ISO_DAY_RE.exec(String(value || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return null;
  return { year, month, day, date };
}

function monthStart(value) {
  const parsed = parseIsoDay(value);
  if (parsed) return `${pad(parsed.year, 4)}-${pad(parsed.month)}-01`;
  const now = new Date();
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-01`;
}

function addDays(dayStr, delta) {
  const parsed = parseIsoDay(dayStr);
  if (!parsed) return '';
  const d = new Date(parsed.year, parsed.month - 1, parsed.day + delta);
  return todayIsoDay(d);
}

function addMonths(monthStr, delta) {
  const parsed = parseIsoDay(monthStr);
  if (!parsed) return monthStart('');
  const d = new Date(parsed.year, parsed.month - 1 + delta, 1);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-01`;
}

function monthEnd(monthStr) {
  return addDays(addMonths(monthStr, 1), -1);
}

function calendarDays(monthStr) {
  const parsed = parseIsoDay(monthStr) || parseIsoDay(monthStart(''));
  const first = new Date(parsed.year, parsed.month - 1, 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(parsed.year, parsed.month - 1, 1 - mondayOffset);
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push(todayIsoDay(d));
  }
  return cells;
}

function formatDayDisplay(value) {
  const parsed = parseIsoDay(value);
  if (!parsed) return '';
  return `${parsed.year}/${pad(parsed.month)}/${pad(parsed.day)}`;
}

function formatMonthTitle(monthStr) {
  const parsed = parseIsoDay(monthStr);
  return parsed ? `${parsed.year}年${parsed.month}月` : '';
}

function isDayDisabled(day, min, max) {
  if (!day) return true;
  if (min && day < min) return true;
  if (max && day > max) return true;
  return false;
}

function normalizeTime(value) {
  const m = /^(\d{2}):(\d{2})/.exec(String(value || '').trim());
  if (!m) return '';
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return '';
  return `${pad(hh)}:${pad(mm)}`;
}

function portalTarget(anchor) {
  return anchor.closest('dialog[open]') || document.body;
}

function positionPopover(el, anchor, desiredWidth, estimatedHeight, matchAnchorWidth = false) {
  const rect = anchor.getBoundingClientRect();
  const width = matchAnchorWidth
    ? Math.max(rect.width, Math.min(desiredWidth, window.innerWidth - 16))
    : Math.min(desiredWidth, window.innerWidth - 16);
  const roomBelow = window.innerHeight - rect.bottom - 10;
  const roomAbove = rect.top - 10;
  const showAbove = roomBelow < estimatedHeight && roomAbove > roomBelow;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));

  el.style.width = `${Math.round(width)}px`;
  el.style.left = `${Math.round(left)}px`;
  if (showAbove) {
    el.style.top = 'auto';
    el.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`;
    el.style.maxHeight = `${Math.max(150, Math.round(roomAbove))}px`;
  } else {
    el.style.bottom = 'auto';
    el.style.top = `${Math.round(rect.bottom + 6)}px`;
    el.style.maxHeight = `${Math.max(150, Math.round(roomBelow))}px`;
  }
}

export function closeActivePopover(restoreFocus = false) {
  if (!activePopover) return false;
  const { el, anchor, onClose } = activePopover;
  activePopover = null;
  el.remove();
  anchor?.classList.remove('is-open');
  anchor?.setAttribute('aria-expanded', 'false');
  onClose?.();
  if (restoreFocus && anchor?.isConnected) anchor.focus();
  return true;
}

export function isPopoverEventTarget(target) {
  if (!activePopover) return false;
  return Boolean(activePopover.el.contains(target) || activePopover.anchor?.contains(target));
}

export function renderSelectTriggerHtml({
  id = '',
  label,
  value = '',
  options = [],
  placeholder = '请选择',
  className = '',
  disabled = false,
}) {
  const selected = options.find((opt) => opt.value === value);
  const text = selected ? selected.label : placeholder;
  return `
    <button
      type="button"
      class="tb-select-trigger ${className}"
      ${id ? `id="${esc(id)}"` : ''}
      aria-haspopup="listbox"
      aria-expanded="false"
      aria-label="${esc(label)}"
      ${disabled ? 'disabled' : ''}
    >
      <span class="${selected ? 'tb-select-value' : 'tb-select-placeholder'}">${esc(text)}</span>
      <span class="tb-select-chevron" aria-hidden="true">${CHEVRON_DOWN_SVG}</span>
    </button>
  `;
}

export function mountSelect(triggerEl, {
  label = '',
  value = '',
  options = [],
  emptyText = '暂无选项',
  minMenuWidth = 148,
  onChange,
}) {
  if (!triggerEl) return;

  const openMenu = () => {
    const wasSameAnchor = activePopover?.anchor === triggerEl;
    closeActivePopover();
    if (wasSameAnchor) return;

    const menu = document.createElement('div');
    menu.className = 'tb-select-menu';
    menu.setAttribute('role', 'listbox');
    if (label) menu.setAttribute('aria-label', label);

    if (!options.length) {
      const empty = document.createElement('div');
      empty.className = 'tb-select-empty';
      empty.textContent = emptyText;
      menu.appendChild(empty);
    } else {
      for (const opt of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `tb-select-option${opt.value === value ? ' is-selected' : ''}`;
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', opt.value === value ? 'true' : 'false');
        btn.innerHTML = `
          <span class="tb-select-option-label">${esc(opt.label)}</span>
          <span class="tb-select-check">${opt.value === value ? CHECK_SVG : ''}</span>
        `;
        btn.addEventListener('click', () => {
          closeActivePopover(true);
          onChange?.(opt.value);
        });
        menu.appendChild(btn);
      }
    }

    portalTarget(triggerEl).appendChild(menu);
    const estHeight = Math.min(260, Math.max(48, options.length * 32 + 12));
    positionPopover(menu, triggerEl, Math.max(minMenuWidth, triggerEl.offsetWidth), estHeight, true);
    triggerEl.classList.add('is-open');
    triggerEl.setAttribute('aria-expanded', 'true');
    activePopover = { el: menu, anchor: triggerEl };

    const focusTarget = menu.querySelector('.is-selected') || menu.querySelector('.tb-select-option');
    if (focusTarget) focusTarget.focus();

    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('.tb-select-option')];
      if (!items.length) return;
      const idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(idx + 1) % items.length].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(idx - 1 + items.length) % items.length].focus();
      }
    });
  };

  triggerEl.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu();
  });

  triggerEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu();
    }
  });
}

export function renderDateTriggerHtml({
  id = '',
  label,
  value = '',
  placeholder = '选择日期',
  includeTime = false,
  className = '',
  disabled = false,
}) {
  const [dayPart, timePart = ''] = includeTime ? String(value || '').split('T') : [value];
  const dayText = formatDayDisplay(dayPart);
  const display = dayText && timePart ? `${dayText} ${timePart}` : dayText;
  return `
    <button
      type="button"
      class="tb-date-trigger ${className}"
      ${id ? `id="${esc(id)}"` : ''}
      aria-haspopup="dialog"
      aria-expanded="false"
      aria-label="${esc(label)}"
      ${disabled ? 'disabled' : ''}
    >
      <span class="tb-date-leading" aria-hidden="true">${CALENDAR_SVG}</span>
      <span class="${display ? 'tb-date-value' : 'tb-date-placeholder'}">${esc(display || placeholder)}</span>
      <span class="tb-date-chevron" aria-hidden="true">${CHEVRON_DOWN_SVG}</span>
    </button>
  `;
}

export function mountDatePicker(triggerEl, {
  label = '选择日期',
  value = '',
  min = '',
  max = '',
  includeTime = false,
  placeholder = '选择日期',
  onChange,
}) {
  if (!triggerEl) return;

  const commit = (nextValue) => {
    const [dayPart, timePart = ''] = includeTime ? String(nextValue || '').split('T') : [nextValue];
    const dayText = formatDayDisplay(dayPart);
    const display = dayText && timePart ? `${dayText} ${timePart}` : dayText;
    const textEl = triggerEl.querySelector('.tb-date-value, .tb-date-placeholder');
    if (textEl) {
      textEl.className = display ? 'tb-date-value' : 'tb-date-placeholder';
      textEl.textContent = display || placeholder;
    }
    onChange?.(nextValue);
  };

  const openPopover = () => {
    const wasSameAnchor = activePopover?.anchor === triggerEl;
    closeActivePopover();
    if (wasSameAnchor) return;

    const [initDay, initTime = ''] = includeTime ? String(value || '').split('T') : [value];
    const committedDay = parseIsoDay(initDay) ? initDay : '';
    let visibleMonth = monthStart(committedDay || min || max);
    let draftDay = committedDay;
    let draftTime = normalizeTime(initTime) || '09:00';
    const today = todayIsoDay();

    const popover = document.createElement('div');
    popover.className = 'tb-date-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', label);

    const draw = () => {
      const days = calendarDays(visibleMonth);
      const currentMonthKey = visibleMonth.slice(0, 7);
      const prevMonth = addMonths(visibleMonth, -1);
      const nextMonth = addMonths(visibleMonth, 1);
      const canPrev = Boolean(parseIsoDay(prevMonth)) && (!min || monthEnd(prevMonth) >= min);
      const canNext = Boolean(parseIsoDay(nextMonth)) && (!max || nextMonth <= max);
      const todayDisabled = isDayDisabled(today, min, max);
      const selected = includeTime ? draftDay : committedDay;

      popover.innerHTML = `
        <div class="tb-date-head">
          <button type="button" class="tb-date-nav" data-nav="-1" aria-label="上个月" ${canPrev ? '' : 'disabled'}>${CHEVRON_LEFT_SVG}</button>
          <span class="tb-date-month">${esc(formatMonthTitle(visibleMonth))}</span>
          <button type="button" class="tb-date-nav" data-nav="1" aria-label="下个月" ${canNext ? '' : 'disabled'}>${CHEVRON_RIGHT_SVG}</button>
        </div>
        <div class="tb-date-weekdays" aria-hidden="true">
          ${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}
        </div>
        <div class="tb-date-grid">
          ${days.map((day) => {
            const outside = !day.startsWith(currentMonthKey);
            const disabled = isDayDisabled(day, min, max);
            const classes = [
              'tb-date-day',
              outside ? 'is-outside' : '',
              day === today ? 'is-today' : '',
              day === selected ? 'is-selected' : '',
            ].filter(Boolean).join(' ');
            return `<button type="button" class="${classes}" data-day="${day}" ${disabled ? 'disabled' : ''}>${Number(day.slice(-2))}</button>`;
          }).join('')}
        </div>
        ${includeTime ? `
          <div class="tb-date-time">
            <span class="tb-date-time-icon" aria-hidden="true">${CLOCK_SVG}</span>
            <span>时间</span>
            <input type="time" class="tb-input tb-date-time-input" value="${esc(draftTime)}" aria-label="时间" />
            <button type="button" class="tb-date-confirm" ${draftDay && normalizeTime(draftTime) ? '' : 'disabled'}>确定</button>
          </div>
        ` : ''}
        <div class="tb-date-footer">
          <button type="button" class="tb-date-footer-btn" data-date-action="clear" ${!(selected || committedDay) ? 'disabled' : ''}>清除</button>
          <button type="button" class="tb-date-footer-btn is-primary" data-date-action="today" ${todayDisabled ? 'disabled' : ''}>今天</button>
        </div>
      `;

      popover.querySelector('[data-nav="-1"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        visibleMonth = prevMonth;
        draw();
      });
      popover.querySelector('[data-nav="1"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        visibleMonth = nextMonth;
        draw();
      });

      popover.querySelectorAll('[data-day]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const day = btn.getAttribute('data-day');
          if (!day) return;
          if (!includeTime) {
            closeActivePopover(true);
            commit(day);
            return;
          }
          draftDay = day;
          if (!day.startsWith(visibleMonth.slice(0, 7))) visibleMonth = monthStart(day);
          draw();
        });
      });

      const timeInput = popover.querySelector('.tb-date-time-input');
      const confirmBtn = popover.querySelector('.tb-date-confirm');
      timeInput?.addEventListener('input', (e) => {
        draftTime = e.target.value;
        if (confirmBtn) confirmBtn.disabled = !(draftDay && normalizeTime(draftTime));
      });
      confirmBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = normalizeTime(draftTime);
        if (!draftDay || !t) return;
        closeActivePopover(true);
        commit(`${draftDay}T${t}`);
      });

      popover.querySelector('[data-date-action="clear"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeActivePopover(true);
        commit('');
      });

      popover.querySelector('[data-date-action="today"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (todayDisabled) return;
        if (!includeTime) {
          closeActivePopover(true);
          commit(today);
          return;
        }
        const now = new Date();
        const nowTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        closeActivePopover(true);
        commit(`${today}T${nowTime}`);
      });
    };

    draw();
    portalTarget(triggerEl).appendChild(popover);
    positionPopover(popover, triggerEl, 276, includeTime ? 360 : 316, false);
    triggerEl.classList.add('is-open');
    triggerEl.setAttribute('aria-expanded', 'true');
    activePopover = { el: popover, anchor: triggerEl };
  };

  triggerEl.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover();
  });
}
