/**
 * DOM actions against guest tabs using data-pi-ref from the last snapshot.
 */
const { getTabWebContents, resolveBrowserTab } = require('./tabs.cjs');
const { captureBrowserSnapshot } = require('./snapshot.cjs');
const { enqueueBrowserAction } = require('./queue.cjs');
const { assertSiteActionAllowed } = require('./site-policy.cjs');
const { assertBrowserEvaluateAllowed, getBrowserPreferences } = require('./settings.cjs');

function runInTab(tabId, script) {
  const entry = resolveBrowserTab(tabId);
  const contents = getTabWebContents(entry);
  if (!contents) throw new Error('浏览器标签尚未就绪');
  return contents.executeJavaScript(script, true).then((result) => {
    try {
      entry.url = contents.getURL() || entry.url;
      entry.title = contents.getTitle() || entry.title;
    } catch {
      // Guest may have navigated away.
    }
    return { entry, contents, result };
  });
}

function withTabAction(tabId, actionClass, work) {
  const entry = resolveBrowserTab(tabId);
  assertSiteActionAllowed(entry.url, actionClass);
  return enqueueBrowserAction(entry.id, async () => {
    const live = resolveBrowserTab(entry.id);
    assertSiteActionAllowed(live.url, actionClass);
    return work(entry.id);
  });
}

async function maybeSnapshot(entry, enabled) {
  if (enabled === false) return undefined;
  const contents = getTabWebContents(entry);
  if (!contents) return undefined;
  try {
    const snapshot = await captureBrowserSnapshot(contents, { maxChars: 6_000 });
    return {
      url: snapshot.url,
      title: snapshot.title,
      mode: snapshot.mode,
      nodeCount: Object.keys(snapshot.refs || {}).length,
      truncated: snapshot.truncated,
      warnings: snapshot.warnings,
    };
  } catch {
    return undefined;
  }
}

function highlightScript(ref, label, clearOthers) {
  return `(() => {
    if (!window.__piHighlightReady) {
      const style = document.createElement('style');
      style.id = 'pi-browser-highlight-style';
      style.textContent = ${JSON.stringify(`
    [data-pi-highlight="1"] {
      outline: 2px solid #3b82f6 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.28) !important;
      border-radius: 2px;
    }
    #pi-browser-highlight-label {
      position: fixed;
      z-index: 2147483646;
      pointer-events: none;
      background: #1d4ed8;
      color: #fff;
      font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 4px 8px;
      border-radius: 6px;
      box-shadow: 0 4px 14px rgba(15, 23, 42, 0.28);
      max-width: min(280px, 70vw);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `)};
      (document.head || document.documentElement).appendChild(style);
      window.__piHighlightReady = true;
    }
    const clearOthers = ${clearOthers ? 'true' : 'false'};
    const target = ${JSON.stringify(String(ref || ''))};
    const labelText = ${JSON.stringify(String(label || ref || ''))};
    if (clearOthers) {
      document.querySelectorAll('[data-pi-highlight="1"]').forEach((el) => el.removeAttribute('data-pi-highlight'));
      const old = document.getElementById('pi-browser-highlight-label');
      if (old) old.remove();
    }
    if (!target) return { ok: true, cleared: true };
    const el = document.querySelector('[data-pi-ref=' + JSON.stringify(target) + ']');
    if (!el) return { ok: false, error: '找不到元素，请重新 snapshot' };
    el.setAttribute('data-pi-highlight', '1');
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    let badge = document.getElementById('pi-browser-highlight-label');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'pi-browser-highlight-label';
      document.documentElement.appendChild(badge);
    }
    badge.textContent = labelText || target;
    const top = Math.max(8, Math.min(window.innerHeight - 28, rect.top - 28));
    const left = Math.max(8, Math.min(window.innerWidth - 120, rect.left));
    badge.style.top = top + 'px';
    badge.style.left = left + 'px';
    return {
      ok: true,
      ref: target,
      tag: el.tagName.toLowerCase(),
      name: String(el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 80),
    };
  })()`;
}

async function clearBrowserHighlights(tabId) {
  return withTabAction(tabId, 'read', async (id) => {
    const { entry, result } = await runInTab(id, highlightScript('', '', true));
    return { ok: true, tabId: entry.id, url: entry.url, cleared: true, ...result };
  });
}

async function highlightBrowserRef(tabId, ref, options = {}) {
  const target = String(ref || '').trim();
  if (!target && options.clear !== true) throw new Error('需要 ref（先 browser_snapshot），或 clear: true');
  return withTabAction(tabId, 'read', async (id) => {
    if (!target || options.clear === true) {
      const { entry } = await runInTab(id, highlightScript('', '', true));
      return { ok: true, tabId: entry.id, url: entry.url, cleared: true };
    }
    const label = options.label || target;
    const { entry, result } = await runInTab(id, highlightScript(target, label, options.clearOthers !== false));
    if (!result?.ok) throw new Error(result?.error || '高亮失败');
    return {
      ok: true,
      tabId: entry.id,
      url: entry.url,
      ref: target,
      element: result,
    };
  });
}

async function flashHighlight(id, ref, label) {
  try {
    await runInTab(id, highlightScript(ref, label || ref, true));
  } catch {
    // Highlight is best-effort; actions still proceed.
  }
}

async function clickBrowserRef(tabId, ref, options = {}) {
  const target = String(ref || '').trim();
  if (!target) throw new Error('需要 ref（先 browser_snapshot）');
  return withTabAction(tabId, 'act', async (id) => {
    await flashHighlight(id, target, options.label || target);
    const { entry, result } = await runInTab(id, `(() => {
      const el = document.querySelector('[data-pi-ref=' + JSON.stringify(${JSON.stringify(target)}) + ']');
      if (!el) return { ok: false, error: '找不到元素，请重新 snapshot' };
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const cx = rect.left + Math.min(rect.width / 2, Math.max(4, rect.width - 4));
      const cy = rect.top + Math.min(rect.height / 2, Math.max(4, rect.height - 4));
      const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      if (typeof el.focus === 'function') el.focus();
      if (typeof el.click === 'function') el.click();
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        name: String(el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 80),
      };
    })()`);
    if (!result?.ok) throw new Error(result?.error || '点击失败');
    return {
      ok: true,
      tabId: entry.id,
      url: entry.url,
      ref: target,
      element: result,
      snapshot: await maybeSnapshot(entry, options.snapshot),
    };
  });
}

async function typeBrowserRef(tabId, ref, text, options = {}) {
  const target = String(ref || '').trim();
  if (!target) throw new Error('需要 ref（先 browser_snapshot）');
  const value = String(text ?? '');
  if (value.length > 20_000) throw new Error('输入过长');
  const clear = options.clear !== false;
  const submit = options.submit === true;
  return withTabAction(tabId, 'act', async (id) => {
    await flashHighlight(id, target, options.label || target);
    const { entry, result } = await runInTab(id, `(() => {
      const el = document.querySelector('[data-pi-ref=' + JSON.stringify(${JSON.stringify(target)}) + ']');
      if (!el) return { ok: false, error: '找不到元素，请重新 snapshot' };
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      if (typeof el.focus === 'function') el.focus();
      const text = ${JSON.stringify(value)};
      const clear = ${clear ? 'true' : 'false'};
      if (el.isContentEditable) {
        if (clear) el.textContent = '';
        el.textContent = (el.textContent || '') + text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      } else if ('value' in el) {
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        const setter = descriptor && descriptor.set;
        const next = (clear ? '' : String(el.value || '')) + text;
        if (setter) setter.call(el, next);
        else el.value = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        return { ok: false, error: '该元素不支持输入' };
      }
      if (${submit ? 'true' : 'false'}) {
        const form = typeof el.form !== 'undefined' ? el.form : el.closest('form');
        if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
        else if (form) form.submit();
        else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      }
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        value: ('value' in el ? String(el.value || '') : String(el.textContent || '')).slice(0, 120),
      };
    })()`);
    if (!result?.ok) throw new Error(result?.error || '输入失败');
    return {
      ok: true,
      tabId: entry.id,
      url: entry.url,
      ref: target,
      element: result,
      snapshot: await maybeSnapshot(entry, options.snapshot),
    };
  });
}

async function selectBrowserRef(tabId, ref, values, options = {}) {
  const target = String(ref || '').trim();
  if (!target) throw new Error('需要 ref（先 browser_snapshot）');
  const list = Array.isArray(values) ? values.map((item) => String(item)) : [String(values ?? '')];
  if (!list.length || list.every((item) => !item)) throw new Error('需要 values');
  return withTabAction(tabId, 'act', async (id) => {
    await flashHighlight(id, target, options.label || target);
    const { entry, result } = await runInTab(id, `(() => {
      const el = document.querySelector('[data-pi-ref=' + JSON.stringify(${JSON.stringify(target)}) + ']');
      if (!el) return { ok: false, error: '找不到元素，请重新 snapshot' };
      if (el.tagName !== 'SELECT') return { ok: false, error: '目标不是下拉框' };
      const wanted = ${JSON.stringify(list)};
      const selected = [];
      for (const option of Array.from(el.options || [])) {
        const match = wanted.includes(option.value) || wanted.includes(option.textContent.trim());
        option.selected = match;
        if (match) selected.push(option.value || option.textContent.trim());
      }
      if (!selected.length) return { ok: false, error: '没有匹配的选项' };
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected };
    })()`);
    if (!result?.ok) throw new Error(result?.error || '选择失败');
    return {
      ok: true,
      tabId: entry.id,
      url: entry.url,
      ref: target,
      selected: result.selected,
      snapshot: await maybeSnapshot(entry, options.snapshot),
    };
  });
}

async function scrollBrowser(tabId, options = {}) {
  return withTabAction(tabId, 'act', async (id) => {
    const ref = String(options.ref || '').trim();
    const direction = String(options.direction || 'down').toLowerCase();
    const amount = Math.min(4_000, Math.max(1, Number(options.amount) || 600));
    const delta = {
      down: [0, amount],
      up: [0, -amount],
      right: [amount, 0],
      left: [-amount, 0],
    }[direction] || [0, amount];
    if (ref) await flashHighlight(id, ref, ref);
    const { entry, result } = await runInTab(id, `(() => {
      const ref = ${JSON.stringify(ref)};
      if (ref) {
        const el = document.querySelector('[data-pi-ref=' + JSON.stringify(ref) + ']');
        if (!el) return { ok: false, error: '找不到元素，请重新 snapshot' };
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        return { ok: true, mode: 'ref', x: window.scrollX, y: window.scrollY };
      }
      window.scrollBy(${delta[0]}, ${delta[1]});
      return { ok: true, mode: 'window', x: window.scrollX, y: window.scrollY, direction: ${JSON.stringify(direction)} };
    })()`);
    if (!result?.ok) throw new Error(result?.error || '滚动失败');
    return { ok: true, tabId: entry.id, url: entry.url, ...result };
  });
}

async function waitBrowser(tabId, options = {}) {
  const timeoutMs = Math.min(60_000, Math.max(100, Number(options.timeoutMs) || 10_000));
  const ref = String(options.ref || '').trim();
  const urlIncludes = String(options.urlIncludes || '').trim();
  const textIncludes = String(options.textIncludes || '').trim();
  return withTabAction(tabId, 'wait', async (id) => {
    const started = Date.now();
    let lastError = '等待超时';
    while (Date.now() - started < timeoutMs) {
      const { entry, result } = await runInTab(id, `(() => {
        const ref = ${JSON.stringify(ref)};
        const urlIncludes = ${JSON.stringify(urlIncludes)};
        const textIncludes = ${JSON.stringify(textIncludes)};
        if (ref) {
          const el = document.querySelector('[data-pi-ref=' + JSON.stringify(ref) + ']');
          if (!el) return { ok: false, error: 'ref 尚未出现' };
        }
        if (urlIncludes && !String(location.href).includes(urlIncludes)) {
          return { ok: false, error: 'URL 尚未匹配' };
        }
        if (textIncludes) {
          const body = document.body ? (document.body.innerText || '') : '';
          if (!body.includes(textIncludes)) return { ok: false, error: '文本尚未出现' };
        }
        return { ok: true, url: location.href, title: document.title || '' };
      })()`);
      if (result?.ok) {
        if (ref) await flashHighlight(id, ref, ref);
        return {
          ok: true,
          tabId: entry.id,
          url: result.url || entry.url,
          title: result.title || entry.title,
          waitedMs: Date.now() - started,
        };
      }
      lastError = result?.error || lastError;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`${lastError}（${timeoutMs}ms）`);
  });
}

async function installDialogBridge(tabId) {
  const entry = resolveBrowserTab(tabId);
  const contents = getTabWebContents(entry);
  if (!contents) throw new Error('浏览器标签尚未就绪');
  await contents.executeJavaScript(`(() => {
    if (window.__piDialogBridge) return true;
    window.__piDialogQueue = window.__piDialogQueue || [];
    window.__piDialogNext = window.__piDialogNext || null;
    const push = (type, message, def) => {
      const item = { id: 'dlg_' + Date.now().toString(36), type, message: String(message || ''), defaultValue: def, at: Date.now() };
      window.__piDialogQueue.push(item);
      while (window.__piDialogQueue.length > 20) window.__piDialogQueue.shift();
      const next = window.__piDialogNext;
      window.__piDialogNext = null;
      if (!next) {
        if (type === 'confirm') return true;
        if (type === 'prompt') return def == null ? '' : String(def);
        return undefined;
      }
      if (type === 'confirm') return next.accept !== false;
      if (type === 'prompt') return next.accept === false ? null : String(next.promptText ?? def ?? '');
      return undefined;
    };
    window.alert = (message) => { push('alert', message); };
    window.confirm = (message) => push('confirm', message);
    window.prompt = (message, def) => push('prompt', message, def);
    window.__piDialogBridge = true;
    return true;
  })()`, true);
  return entry;
}

async function handleBrowserDialog(tabId, options = {}) {
  return withTabAction(tabId, 'dialog', async (id) => {
    await installDialogBridge(id);
    const accept = options.accept !== false;
    const promptText = options.promptText == null ? '' : String(options.promptText);
    const { entry, result } = await runInTab(id, `(() => {
      window.__piDialogNext = {
        accept: ${accept ? 'true' : 'false'},
        promptText: ${JSON.stringify(promptText)},
      };
      const pending = Array.isArray(window.__piDialogQueue) ? window.__piDialogQueue.slice(-5) : [];
      return { ok: true, pending, next: window.__piDialogNext };
    })()`);
    return {
      ok: true,
      tabId: entry.id,
      url: entry.url,
      accept,
      promptText,
      pending: result?.pending || [],
    };
  });
}

async function listBrowserDialogs(tabId) {
  const entry = resolveBrowserTab(tabId);
  assertSiteActionAllowed(entry.url, 'dialog');
  await installDialogBridge(entry.id);
  const { result } = await runInTab(entry.id, `(() => ({
    pending: Array.isArray(window.__piDialogQueue) ? window.__piDialogQueue.slice(-10) : [],
    next: window.__piDialogNext || null,
  }))()`);
  return { tabId: entry.id, ...(result || { pending: [] }) };
}

async function evaluateBrowserScript(tabId, expression, options = {}) {
  const source = String(expression || '').trim();
  if (!source) throw new Error('需要 expression');
  if (source.length > 20_000) throw new Error('脚本过长');
  const entry = resolveBrowserTab(tabId);
  assertBrowserEvaluateAllowed(entry.url);
  return withTabAction(entry.id, 'evaluate', async (id) => {
    const live = resolveBrowserTab(id);
    assertBrowserEvaluateAllowed(live.url);
    const { entry: current, result } = await runInTab(id, `(() => {
      try {
        const value = (0, eval)(${JSON.stringify(source)});
        let preview;
        try {
          preview = JSON.stringify(value, (_key, item) => {
            if (typeof item === 'bigint') return String(item);
            if (typeof item === 'function') return '[Function]';
            if (item && typeof item === 'object') {
              if (item instanceof Error) return { name: item.name, message: item.message };
              if (typeof Node !== 'undefined' && item instanceof Node) {
                return { nodeType: item.nodeType, tag: item.nodeName };
              }
            }
            return item;
          });
        } catch {
          preview = String(value);
        }
        if (typeof preview === 'string' && preview.length > 4000) {
          preview = preview.slice(0, 4000) + '…';
        }
        return { ok: true, preview, type: value === null ? 'null' : typeof value };
      } catch (error) {
        return {
          ok: false,
          error: error && error.message ? String(error.message) : String(error || 'evaluate failed'),
        };
      }
    })()`);
    if (!result?.ok) throw new Error(result?.error || '脚本执行失败');
    return {
      ok: true,
      tabId: current.id,
      url: current.url,
      type: result.type,
      preview: result.preview,
      note: options.note ? String(options.note).slice(0, 200) : undefined,
    };
  });
}

module.exports = {
  clearBrowserHighlights,
  clickBrowserRef,
  evaluateBrowserScript,
  handleBrowserDialog,
  highlightBrowserRef,
  installDialogBridge,
  listBrowserDialogs,
  scrollBrowser,
  selectBrowserRef,
  typeBrowserRef,
  waitBrowser,
};
