/**
 * Declarative extension UI normalization.
 *
 * The renderer only accepts this canonical shape. Extensions cannot provide
 * components, HTML, CSS, inline styles, event names, or arbitrary IPC. Values
 * are bounded here so a malformed manifest or live data source cannot freeze a
 * window or bypass the Studio design system.
 */

const MAX_BLOCKS = 64;
const MAX_DEPTH = 5;
const MAX_ACTIONS = 12;
const MAX_TABS = 8;
const MAX_METRICS = 24;
const MAX_SERIES = 4;
const MAX_POINTS = 256;
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_ROWS = 200;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTRIBUTION_PATTERN = /^(?:builtin|user|project):[a-z0-9][a-z0-9._-]{1,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const TONES = new Set(['neutral', 'info', 'success', 'warning', 'error']);
const NOTICE_TONES = new Set(['info', 'success', 'warning', 'error']);
const STATUSES = new Set(['pending', 'active', 'success', 'warning', 'error', 'neutral']);
const DENSITIES = new Set(['compact', 'comfortable', 'spacious']);
const ALIGNMENTS = new Set(['left', 'right', 'center']);
const CHART_TONES = new Set(['accent', 'info', 'success', 'warning', 'error']);
const BUTTON_TONES = new Set(['default', 'primary', 'danger']);

function fail(path, message) {
  return new Error(`UI ${path} ${message}`);
}

function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function childPath(parent, field) {
  return parent ? `${parent}.${field}` : field;
}

function itemPath(parent, field, index) {
  return `${childPath(parent, field)}[${index}]`;
}

function requiredText(path, value, field, maxLength) {
  const clean = text(value, maxLength);
  if (!clean) throw fail(childPath(path, field), '不能为空');
  return clean;
}

function plainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function objectAt(path, value, field = 'value') {
  if (!plainObject(value)) throw fail(path, `${field} 必须是对象`);
  return value;
}

function allowedKeys(path, value, keys) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw fail(path, `不支持字段 ${key}`);
  }
}

function boundedArray(path, value, field, maximum, minimum = 0) {
  const pathToField = childPath(path, field);
  if (!Array.isArray(value)) throw fail(pathToField, '必须是数组');
  if (value.length < minimum) throw fail(pathToField, `至少需要 ${minimum} 项`);
  if (value.length > maximum) throw fail(pathToField, `最多允许 ${maximum} 项`);
  return value;
}

function normalizeTone(path, value, fallback = 'neutral', allowed = TONES) {
  if (value === undefined) return fallback;
  if (!allowed.has(value)) throw fail(childPath(path, 'tone'), `无效：${String(value)}`);
  return value;
}

function normalizeId(path, value, field = 'id') {
  const clean = text(value, 64);
  if (!ID_PATTERN.test(clean)) throw fail(childPath(path, field), '无效');
  return clean;
}

function normalizeActionButton(path, raw, owner, normalizeAction) {
  const value = objectAt(path, raw, 'action button');
  allowedKeys(path, value, new Set(['id', 'label', 'tone', 'action']));
  const id = normalizeId(path, value.id);
  const label = requiredText(path, value.label, 'label', 120);
  if (value.tone !== undefined && !BUTTON_TONES.has(value.tone)) {
    throw fail(childPath(path, 'tone'), `button tone 无效：${String(value.tone)}`);
  }
  const action = normalizeAction(value.action, owner);
  if (!action) throw fail(childPath(path, 'action'), '无效');
  return {
    id,
    label,
    tone: BUTTON_TONES.has(value.tone) ? value.tone : 'default',
    action,
  };
}

function assertUniqueIds(path, items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw fail(path, `${label} id 重复：${item.id}`);
    seen.add(item.id);
  }
}

function normalizeMetric(path, raw) {
  const value = objectAt(path, raw, 'metric');
  allowedKeys(path, value, new Set(['kind', 'id', 'label', 'value', 'unit', 'detail', 'trend', 'tone']));
  const id = normalizeId(path, value.id);
  const label = requiredText(path, value.label, 'label', 120);
  if (
    typeof value.value !== 'number'
    && typeof value.value !== 'string'
  ) {
    throw fail(childPath(path, 'value'), '必须是字符串或数字');
  }
  if (typeof value.value === 'number' && !Number.isFinite(value.value)) {
    throw fail(childPath(path, 'value'), '必须是有限数字');
  }
  const metric = {
    id,
    label,
    value: typeof value.value === 'number'
      ? value.value
      : requiredText(path, value.value, 'value', 120),
    tone: normalizeTone(path, value.tone),
  };
  const unit = text(value.unit, 32);
  const detail = text(value.detail, 240);
  if (unit) metric.unit = unit;
  if (detail) metric.detail = detail;
  if (value.trend !== undefined) {
    const trendPath = childPath(path, 'trend');
    const trend = objectAt(trendPath, value.trend);
    allowedKeys(trendPath, trend, new Set(['direction', 'label', 'tone']));
    if (!['up', 'down', 'flat'].includes(trend.direction)) {
      throw fail(childPath(trendPath, 'direction'), '只能是 up、down 或 flat');
    }
    if (trend.tone !== undefined && !['neutral', 'positive', 'negative'].includes(trend.tone)) {
      throw fail(childPath(trendPath, 'tone'), '只能是 neutral、positive 或 negative');
    }
    metric.trend = {
      direction: trend.direction,
      label: requiredText(trendPath, trend.label, 'label', 80),
      tone: trend.tone || 'neutral',
    };
  }
  return metric;
}

function normalizeNumericSeries(path, raw, field, maximum = MAX_POINTS) {
  const values = boundedArray(path, raw, field, maximum, 1);
  const fieldPath = childPath(path, field);
  return values.map((entry, pointIndex) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw fail(`${fieldPath}[${pointIndex}]`, '必须是有限数字');
    }
    return entry;
  });
}

function normalizeContentInternal(raw, path, owner, normalizeAction, state, depth) {
  if (depth > MAX_DEPTH) throw fail(path, `嵌套层级不能超过 ${MAX_DEPTH}`);
  if (state.remaining <= 0) throw fail(path, `内容 block 总数不能超过 ${MAX_BLOCKS}`);
  state.remaining -= 1;
  const value = objectAt(path, raw, 'block');
  const kind = text(value.kind, 32);
  if (!kind) throw fail(childPath(path, 'kind'), '不能为空');

  if (kind === 'heading') {
    allowedKeys(path, value, new Set(['kind', 'text', 'level']));
    if (value.level !== undefined && value.level !== 2 && value.level !== 3) {
      throw fail(childPath(path, 'level'), '只能是 2 或 3');
    }
    return {
      kind,
      text: requiredText(path, value.text, 'text', 400),
      level: value.level === 2 ? 2 : 3,
    };
  }
  if (kind === 'text') {
    allowedKeys(path, value, new Set(['kind', 'text']));
    return { kind, text: requiredText(path, value.text, 'text', 8_000) };
  }
  if (kind === 'divider') {
    allowedKeys(path, value, new Set(['kind']));
    return { kind };
  }
  if (kind === 'list') {
    allowedKeys(path, value, new Set(['kind', 'items']));
    const items = boundedArray(path, value.items, 'items', 32, 1).map((item, itemIndex) => {
      const rowPath = itemPath(path, 'items', itemIndex);
      const row = objectAt(rowPath, item, 'list item');
      allowedKeys(rowPath, row, new Set(['title', 'text']));
      return {
        text: requiredText(rowPath, row.text, 'text', 2_000),
        ...(text(row.title, 200) ? { title: text(row.title, 200) } : {}),
      };
    });
    return { kind, items };
  }
  if (kind === 'keyValue') {
    allowedKeys(path, value, new Set(['kind', 'items']));
    const items = boundedArray(path, value.items, 'items', 32, 1).map((item, itemIndex) => {
      const rowPath = itemPath(path, 'items', itemIndex);
      const row = objectAt(rowPath, item, 'key-value item');
      allowedKeys(rowPath, row, new Set(['label', 'value']));
      return {
        label: requiredText(rowPath, row.label, 'label', 200),
        value: requiredText(rowPath, row.value, 'value', 2_000),
      };
    });
    return { kind, items };
  }
  if (kind === 'notice') {
    allowedKeys(path, value, new Set(['kind', 'text', 'tone', 'title']));
    return {
      kind,
      tone: normalizeTone(path, value.tone, 'info', NOTICE_TONES),
      text: requiredText(path, value.text, 'text', 4_000),
      ...(text(value.title, 200) ? { title: text(value.title, 200) } : {}),
    };
  }
  if (kind === 'actions') {
    allowedKeys(path, value, new Set(['kind', 'buttons']));
    const buttons = boundedArray(path, value.buttons, 'buttons', MAX_ACTIONS, 1)
      .map((button, buttonIndex) => normalizeActionButton(
        itemPath(path, 'buttons', buttonIndex),
        button,
        owner,
        normalizeAction,
      ));
    assertUniqueIds(childPath(path, 'buttons'), buttons, 'button');
    if (buttons.filter((button) => button.tone === 'primary').length > 1) {
      throw fail(childPath(path, 'buttons'), '最多只能有一个 primary 操作');
    }
    return { kind, buttons };
  }
  if (kind === 'badge') {
    allowedKeys(path, value, new Set(['kind', 'label', 'tone']));
    return {
      kind,
      label: requiredText(path, value.label, 'label', 120),
      tone: normalizeTone(path, value.tone),
    };
  }
  if (kind === 'emptyState') {
    allowedKeys(path, value, new Set(['kind', 'title', 'text', 'action']));
    return {
      kind,
      title: requiredText(path, value.title, 'title', 160),
      ...(text(value.text, 800) ? { text: text(value.text, 800) } : {}),
      ...(value.action !== undefined
        ? { action: normalizeActionButton(childPath(path, 'action'), value.action, owner, normalizeAction) }
        : {}),
    };
  }

  const recursiveKinds = new Set(['section', 'stack', 'grid', 'tabs', 'disclosure']);
  if (recursiveKinds.has(kind)) {
    if (kind === 'section') {
      allowedKeys(path, value, new Set(['kind', 'title', 'description', 'tone', 'density', 'content']));
      return {
        kind,
        ...(text(value.title, 160) ? { title: text(value.title, 160) } : {}),
        ...(text(value.description, 600) ? { description: text(value.description, 600) } : {}),
        tone: normalizeTone(path, value.tone),
        density: normalizeDensity(path, value.density),
        content: normalizeContentListInternal(
          value.content,
          childPath(path, 'content'),
          owner,
          normalizeAction,
          state,
          depth + 1,
        ),
      };
    }
    if (kind === 'stack') {
      allowedKeys(path, value, new Set(['kind', 'gap', 'content']));
      return {
        kind,
        gap: normalizeDensity(path, value.gap),
        content: normalizeContentListInternal(
          value.content,
          childPath(path, 'content'),
          owner,
          normalizeAction,
          state,
          depth + 1,
        ),
      };
    }
    if (kind === 'grid') {
      allowedKeys(path, value, new Set(['kind', 'columns', 'density', 'content']));
      if (value.columns !== undefined && ![1, 2, 3, 4].includes(value.columns)) {
        throw fail(childPath(path, 'columns'), '只能是 1、2、3 或 4');
      }
      return {
        kind,
        columns: value.columns || 2,
        density: normalizeDensity(path, value.density),
        content: normalizeContentListInternal(
          value.content,
          childPath(path, 'content'),
          owner,
          normalizeAction,
          state,
          depth + 1,
        ),
      };
    }
    if (kind === 'tabs') {
      allowedKeys(path, value, new Set(['kind', 'tabs', 'activeTab']));
      const tabs = boundedArray(path, value.tabs, 'tabs', MAX_TABS, 1).map((rawTab, tabIndex) => {
        const tabPath = itemPath(path, 'tabs', tabIndex);
        const tab = objectAt(tabPath, rawTab, 'tab');
        allowedKeys(tabPath, tab, new Set(['id', 'label', 'content']));
        return {
          id: normalizeId(tabPath, tab.id),
          label: requiredText(tabPath, tab.label, 'label', 80),
          content: normalizeContentListInternal(
            tab.content,
            childPath(tabPath, 'content'),
            owner,
            normalizeAction,
            state,
            depth + 1,
          ),
        };
      });
      const ids = new Set();
      for (const tab of tabs) {
        if (ids.has(tab.id)) throw fail(childPath(path, 'tabs'), `id 重复：${tab.id}`);
        ids.add(tab.id);
      }
      const activeTab = text(value.activeTab, 64);
      if (activeTab && !ids.has(activeTab)) {
        throw fail(childPath(path, 'activeTab'), '必须引用当前 tabs 中的 id');
      }
      return { kind, tabs, ...(activeTab ? { activeTab } : {}) };
    }
    allowedKeys(path, value, new Set(['kind', 'title', 'description', 'open', 'content']));
    return {
      kind,
      title: requiredText(path, value.title, 'title', 160),
      ...(text(value.description, 600) ? { description: text(value.description, 600) } : {}),
      open: value.open === true,
      content: normalizeContentListInternal(
        value.content,
        childPath(path, 'content'),
        owner,
        normalizeAction,
        state,
        depth + 1,
      ),
    };
  }

  if (kind === 'metricGrid') {
    allowedKeys(path, value, new Set(['kind', 'columns', 'metrics']));
    if (value.columns !== undefined && ![1, 2, 3, 4].includes(value.columns)) {
      throw fail(childPath(path, 'columns'), '只能是 1、2、3 或 4');
    }
    const metrics = boundedArray(path, value.metrics, 'metrics', MAX_METRICS, 1)
      .map((metric, metricIndex) => normalizeMetric(itemPath(path, 'metrics', metricIndex), metric));
    assertUniqueIds(childPath(path, 'metrics'), metrics, 'metric');
    return { kind, columns: value.columns || 2, metrics };
  }
  if (kind === 'metric') {
    allowedKeys(path, value, new Set(['kind', 'id', 'label', 'value', 'unit', 'detail', 'trend', 'tone']));
    return { kind, ...normalizeMetric(path, value) };
  }
  if (kind === 'sparkline') {
    allowedKeys(path, value, new Set(['kind', 'label', 'values', 'unit', 'tone']));
    return {
      kind,
      label: requiredText(path, value.label, 'label', 160),
      values: normalizeNumericSeries(path, value.values, 'values'),
      ...(text(value.unit, 32) ? { unit: text(value.unit, 32) } : {}),
      tone: normalizeTone(path, value.tone, 'accent', CHART_TONES),
    };
  }
  if (kind === 'chart') {
    allowedKeys(path, value, new Set(['kind', 'title', 'description', 'labels', 'series', 'unit']));
    const labels = value.labels === undefined
      ? undefined
      : boundedArray(path, value.labels, 'labels', MAX_POINTS).map((label, labelIndex) => {
        if (typeof label !== 'string') {
          throw fail(`${childPath(path, 'labels')}[${labelIndex}]`, '必须是字符串');
        }
        return text(label, 80);
      });
    const series = boundedArray(path, value.series, 'series', MAX_SERIES, 1).map((rawSeries, seriesIndex) => {
      const seriesPath = itemPath(path, 'series', seriesIndex);
      const row = objectAt(seriesPath, rawSeries, 'series');
      allowedKeys(seriesPath, row, new Set(['id', 'label', 'values', 'tone']));
      return {
        id: normalizeId(seriesPath, row.id),
        label: requiredText(seriesPath, row.label, 'label', 120),
        values: normalizeNumericSeries(seriesPath, row.values, 'values'),
        tone: normalizeTone(seriesPath, row.tone, 'accent', CHART_TONES),
      };
    });
    assertUniqueIds(childPath(path, 'series'), series, 'series');
    return {
      kind,
      title: requiredText(path, value.title, 'title', 160),
      ...(text(value.description, 600) ? { description: text(value.description, 600) } : {}),
      ...(labels ? { labels } : {}),
      series,
      ...(text(value.unit, 32) ? { unit: text(value.unit, 32) } : {}),
    };
  }
  if (kind === 'timeline') {
    allowedKeys(path, value, new Set(['kind', 'title', 'items']));
    const items = boundedArray(path, value.items, 'items', 64, 1).map((rawItem, itemIndex) => {
      const rowPath = itemPath(path, 'items', itemIndex);
      const row = objectAt(rowPath, rawItem, 'timeline item');
      allowedKeys(rowPath, row, new Set(['id', 'title', 'detail', 'time', 'status']));
      if (row.status !== undefined && !STATUSES.has(row.status)) {
        throw fail(childPath(rowPath, 'status'), '无效');
      }
      return {
        id: normalizeId(rowPath, row.id),
        title: requiredText(rowPath, row.title, 'title', 160),
        ...(text(row.detail, 600) ? { detail: text(row.detail, 600) } : {}),
        ...(text(row.time, 80) ? { time: text(row.time, 80) } : {}),
        status: row.status || 'neutral',
      };
    });
    assertUniqueIds(childPath(path, 'items'), items, 'timeline item');
    return {
      kind,
      ...(text(value.title, 160) ? { title: text(value.title, 160) } : {}),
      items,
    };
  }
  if (kind === 'statusList') {
    allowedKeys(path, value, new Set(['kind', 'title', 'items']));
    const items = boundedArray(path, value.items, 'items', 64, 1).map((rawItem, itemIndex) => {
      const rowPath = itemPath(path, 'items', itemIndex);
      const row = objectAt(rowPath, rawItem, 'status item');
      allowedKeys(rowPath, row, new Set(['id', 'label', 'detail', 'status']));
      if (row.status !== undefined && !STATUSES.has(row.status)) {
        throw fail(childPath(rowPath, 'status'), '无效');
      }
      return {
        id: normalizeId(rowPath, row.id),
        label: requiredText(rowPath, row.label, 'label', 160),
        ...(text(row.detail, 600) ? { detail: text(row.detail, 600) } : {}),
        status: row.status || 'neutral',
      };
    });
    assertUniqueIds(childPath(path, 'items'), items, 'status item');
    return {
      kind,
      ...(text(value.title, 160) ? { title: text(value.title, 160) } : {}),
      items,
    };
  }
  if (kind === 'table') {
    allowedKeys(path, value, new Set(['kind', 'title', 'columns', 'rows']));
    const columns = boundedArray(path, value.columns, 'columns', MAX_TABLE_COLUMNS, 1)
      .map((rawColumn, columnIndex) => {
        const columnPath = itemPath(path, 'columns', columnIndex);
        const column = objectAt(columnPath, rawColumn, 'column');
        allowedKeys(columnPath, column, new Set(['key', 'label', 'align']));
        if (column.align !== undefined && !ALIGNMENTS.has(column.align)) {
          throw fail(childPath(columnPath, 'align'), '无效');
        }
        return {
          key: normalizeId(columnPath, column.key, 'key'),
          label: requiredText(columnPath, column.label, 'label', 120),
          align: column.align || 'left',
        };
      });
    const keys = new Set(columns.map((column) => column.key));
    if (keys.size !== columns.length) throw fail(childPath(path, 'columns'), 'column key 不能重复');
    const rows = boundedArray(path, value.rows, 'rows', MAX_TABLE_ROWS).map((rawRow, rowIndex) => {
      const rowPath = itemPath(path, 'rows', rowIndex);
      const row = objectAt(rowPath, rawRow, 'table row');
      const output = {};
      for (const column of columns) {
        const cell = row[column.key];
        const cellPath = childPath(rowPath, column.key);
        if (
          cell !== null
          && typeof cell !== 'string'
          && typeof cell !== 'number'
          && typeof cell !== 'boolean'
        ) {
          throw fail(cellPath, '必须是标量');
        }
        if (typeof cell === 'number' && !Number.isFinite(cell)) {
          throw fail(cellPath, '必须是有限数字');
        }
        if (typeof cell === 'string' && cell.length > 2_000) {
          throw fail(cellPath, '过长');
        }
        output[column.key] = cell ?? null;
      }
      return output;
    });
    return {
      kind,
      ...(text(value.title, 160) ? { title: text(value.title, 160) } : {}),
      columns,
      rows,
    };
  }
  if (kind === 'progress') {
    allowedKeys(path, value, new Set(['kind', 'label', 'value', 'max', 'detail', 'tone']));
    if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
      throw fail(childPath(path, 'value'), '必须是有限数字');
    }
    const maximum = value.max === undefined ? 100 : Number(value.max);
    if (!Number.isFinite(maximum) || maximum <= 0) {
      throw fail(childPath(path, 'max'), '必须大于 0');
    }
    return {
      kind,
      label: requiredText(path, value.label, 'label', 160),
      value: Math.max(0, Math.min(maximum, value.value)),
      max: maximum,
      ...(text(value.detail, 240) ? { detail: text(value.detail, 240) } : {}),
      tone: normalizeTone(path, value.tone, 'accent', CHART_TONES),
    };
  }
  if (kind === 'dataView') {
    allowedKeys(path, value, new Set(['kind', 'sourceId', 'emptyText', 'fallback']));
    const sourceId = text(value.sourceId, 220);
    if (!CONTRIBUTION_PATTERN.test(sourceId)) {
      throw fail(childPath(path, 'sourceId'), '必须是完整 contribution ID');
    }
    return {
      kind,
      sourceId,
      ...(text(value.emptyText, 160) ? { emptyText: text(value.emptyText, 160) } : {}),
      ...(value.fallback !== undefined
        ? {
          fallback: normalizeContentListInternal(
            value.fallback,
            childPath(path, 'fallback'),
            owner,
            normalizeAction,
            state,
            depth + 1,
          ),
        }
        : {}),
    };
  }
  throw fail(childPath(path, 'kind'), `不支持 kind ${kind}`);
}

function normalizeDensity(path, value) {
  if (value === undefined) return 'comfortable';
  if (!DENSITIES.has(value)) throw fail(childPath(path, 'density'), `无效：${String(value)}`);
  return value;
}

function normalizeContentListInternal(value, path, owner, normalizeAction, state, depth) {
  const list = boundedArray(path, value, 'items', state.remaining);
  return list.map((item, itemIndex) => (
    normalizeContentInternal(item, itemPath(path, 'items', itemIndex), owner, normalizeAction, state, depth)
  ));
}

function normalizeContentList(value, owner, normalizeAction, maximum = MAX_BLOCKS) {
  if (!Array.isArray(value)) throw new Error('UI content 必须是数组');
  if (value.length > maximum) throw new Error(`UI content 最多允许 ${maximum} 项`);
  const state = { remaining: maximum };
  return value.map((item, index) => normalizeContentInternal(
    item,
    `list.items[${index}]`,
    owner,
    normalizeAction,
    state,
    0,
  ));
}

function normalizeContent(value, owner, normalizeAction, path = 'content') {
  const state = { remaining: MAX_BLOCKS };
  return normalizeContentInternal(value, path, owner, normalizeAction, state, 0);
}

module.exports = {
  MAX_BLOCKS,
  MAX_DEPTH,
  normalizeContent,
  normalizeContentList,
};
