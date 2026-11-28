/**
 * DOM actions against guest tabs using data-pi-ref from the last snapshot,
 * enhanced with real-time virtual AI cursor, floating action pills, click
 * ripples, native keyboard/hover input, drag-and-drop, and viewport emulation.
 */
const { getTabWebContents, listBrowserTabs, resolveBrowserTab } = require('./tabs.cjs');
const { scopedTypography } = require('../../theme.cjs');
const { captureBrowserSnapshot } = require('./snapshot.cjs');
const {
  beginBrowserActivity,
  endBrowserActivity,
  enqueueBrowserAction,
  hasActiveBrowserSession,
  subscribeBrowserControl,
} = require('./queue.cjs');
const { requestRevealBrowserTab, requestSetBrowserViewport } = require('./commands.cjs');
const { assertSiteActionAllowed } = require('./site-policy.cjs');
const { assertBrowserEvaluateAllowed, getBrowserPreferences } = require('./settings.cjs');
const {
  buildAgentCursorScript,
  buildAgentCursorStatusScript,
  buildClearOverlayScript,
  buildOverlayVisibilityScript,
} = require('./overlay.cjs');

const VISUAL_GLIDE_MS = 220;

const FIND_REF_HELPER = `
  const findPiRef = (ref) => {
    if (!ref) return null;
    const selector = '[data-pi-ref=' + JSON.stringify(String(ref)) + ']';
    const search = (root) => {
      if (!root || typeof root.querySelector !== 'function') return null;
      try {
        const direct = root.querySelector(selector);
        if (direct) return direct;
        const all = root.querySelectorAll('*');
        for (const el of all) {
          if (el.shadowRoot) {
            const hit = search(el.shadowRoot);
            if (hit) return hit;
          }
          if (el.tagName === 'IFRAME') {
            try {
              const doc = el.contentDocument;
              if (doc) {
                const hit = search(doc);
                if (hit) return hit;
              }
            } catch {}
          }
        }
      } catch {}
      return null;
    };
    return search(document);
  };
`;

let overlayCleanupTimer = null;
let overlayThinkingTimer = null;

function clearOverlaysAcrossTabs() {
  const clearScript = buildClearOverlayScript();
  for (const tab of listBrowserTabs()) {
    const contents = getTabWebContents(tab);
    if (!contents) continue;
    try {
      void contents.executeJavaScript(clearScript, true).catch(() => {});
    } catch {
      // Ignore destroyed or navigating tabs.
    }
  }
}

function setThinkingCursorOnTab(tabId) {
  if (!shouldAnimateOverlay()) return;
  const statusScript = buildAgentCursorStatusScript('AI 思考下一步…');
  const tabs = listBrowserTabs();
  const target = (tabId && tabs.find((item) => item.id === tabId)) || tabs.find((item) => item.active) || tabs[0];
  if (!target) return;
  const contents = getTabWebContents(target);
  if (!contents) return;
  try {
    void contents.executeJavaScript(statusScript, true).catch(() => {});
  } catch {
    // Ignore destroyed or navigating tabs.
  }
}

subscribeBrowserControl((payload) => {
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'control' && payload.paused === true) {
    if (overlayCleanupTimer) { clearTimeout(overlayCleanupTimer); overlayCleanupTimer = null; }
    if (overlayThinkingTimer) { clearTimeout(overlayThinkingTimer); overlayThinkingTimer = null; }
    clearOverlaysAcrossTabs();
    return;
  }
  const activity = payload.type === 'activity'
    ? payload
    : payload.type === 'control'
      ? payload.activity
      : null;
  if (!activity) return;
  if (activity.active === true) {
    if (overlayCleanupTimer) { clearTimeout(overlayCleanupTimer); overlayCleanupTimer = null; }
    if (activity.thinking === true) {
      if (overlayThinkingTimer) clearTimeout(overlayThinkingTimer);
      overlayThinkingTimer = setTimeout(() => {
        overlayThinkingTimer = null;
        if (hasActiveBrowserSession()) setThinkingCursorOnTab(activity.tabId);
      }, 1200);
      overlayThinkingTimer.unref?.();
    } else if (overlayThinkingTimer) {
      clearTimeout(overlayThinkingTimer);
      overlayThinkingTimer = null;
    }
    return;
  }
  if (activity.active === false) {
    if (overlayThinkingTimer) { clearTimeout(overlayThinkingTimer); overlayThinkingTimer = null; }
    if (overlayCleanupTimer) clearTimeout(overlayCleanupTimer);
    overlayCleanupTimer = setTimeout(() => {
      overlayCleanupTimer = null;
      if (!hasActiveBrowserSession()) clearOverlaysAcrossTabs();
    }, 350);
    overlayCleanupTimer.unref?.();
  }
});

const VIEWPORT_PRESETS = Object.freeze({
  desktop: { width: 1440, height: 900, label: '桌面 1440×900' },
  laptop: { width: 1280, height: 800, label: '笔记本 1280×800' },
  tablet: { width: 768, height: 1024, label: '平板 768×1024' },
  mobile: { width: 390, height: 844, label: '手机 390×844' },
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldAnimateOverlay() {
  try {
    return getBrowserPreferences().annotatedScreenshots !== 'never';
  } catch {
    return true;
  }
}

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

function withTabAction(tabId, actionClass, work, meta = {}) {
  const entry = resolveBrowserTab(tabId);
  assertSiteActionAllowed(entry.url, actionClass);
  return enqueueBrowserAction(entry.id, async () => {
    const live = resolveBrowserTab(entry.id);
    assertSiteActionAllowed(live.url, actionClass);
    if (meta.reveal !== false) {
      try { requestRevealBrowserTab(live.id); } catch { /* best-effort */ }
    }
    const token = meta.trackActivity === false
      ? null
      : beginBrowserActivity({
        tabId: live.id,
        action: meta.action || actionClass,
        label: meta.label || '',
      });
    try {
      return await work(live.id);
    } finally {
      if (token !== null) endBrowserActivity(token);
    }
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
    ${scopedTypography('#pi-browser-highlight-label')}
    [data-pi-highlight="1"] {
      outline: 2px solid #3b82f6 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.24) !important;
      border-radius: 3px;
    }
    #pi-browser-highlight-label {
      position: fixed;
      z-index: 2147483646;
      pointer-events: none;
      background: #1d4ed8;
      color: #fff;
      font: var(--font-description);
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
    const labelText = ${JSON.stringify(String(label || ''))};
    if (clearOthers) {
      document.querySelectorAll('[data-pi-highlight="1"]').forEach((el) => el.removeAttribute('data-pi-highlight'));
      const old = document.getElementById('pi-browser-highlight-label');
      if (old) old.remove();
    }
    if (!target) return { ok: true, cleared: true };
    ${FIND_REF_HELPER}
    const el = findPiRef(target);
    if (!el) return { ok: false, error: '找不到元素，请重新 snapshot' };
    el.setAttribute('data-pi-highlight', '1');
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    const rect = el.getBoundingClientRect();
    if (labelText) {
      let badge = document.getElementById('pi-browser-highlight-label');
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'pi-browser-highlight-label';
        badge.dataset.platform = ${JSON.stringify(process.platform)};
        document.documentElement.appendChild(badge);
      }
      badge.textContent = labelText;
      const top = Math.max(8, Math.min(window.innerHeight - 28, rect.top - 28));
      const left = Math.max(8, Math.min(window.innerWidth - 120, rect.left));
      badge.style.top = top + 'px';
      badge.style.left = left + 'px';
    }
    return {
      ok: true,
      ref: target,
      tag: el.tagName.toLowerCase(),
      name: String(el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 80),
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  })()`;
}

async function clearBrowserHighlights(tabId) {
  return withTabAction(tabId, 'read', async (id) => {
    const { entry, result } = await runInTab(id, highlightScript('', '', true));
    try { await runInTab(id, buildClearOverlayScript()); } catch { /* ignore */ }
    return { ok: true, tabId: entry.id, url: entry.url, cleared: true, ...result };
  }, { reveal: false, trackActivity: false });
}

async function highlightBrowserRef(tabId, ref, options = {}) {
  const target = String(ref || '').trim();
  if (!target && options.clear !== true) throw new Error('需要 ref（先 browser_snapshot），或 clear: true');
  return withTabAction(tabId, 'read', async (id) => {
    if (!target || options.clear === true) {
      const { entry } = await runInTab(id, highlightScript('', '', true));
      try { await runInTab(id, buildClearOverlayScript()); } catch { /* ignore */ }
      return { ok: true, tabId: entry.id, url: entry.url, cleared: true };
    }
    const label = options.label || target;
    const { entry, result } = await runInTab(id, highlightScript(target, label, options.clearOthers !== false));
    if (!result?.ok) throw new Error(result?.error || '高亮失败');
    await showBrowserCursorAction(id, { ref: target, label: options.label || `标注 ${result.name || target}`, kind: 'move' });
    return {
      ok: true,
      tabId: entry.id,
      url: entry.url,
      ref: target,
      element: result,
    };
  }, { action: 'highlight', label: options.label || `标注 ${target}` });
}

async function showBrowserCursorAction(tabId, options = {}) {
  if (!shouldAnimateOverlay()) return null;
  try {
    const persistent = options.persistent !== undefined ? options.persistent : hasActiveBrowserSession();
    const { result } = await runInTab(tabId, buildAgentCursorScript({ ...options, persistent }));
    return result;
  } catch {
    return null;
  }
}

async function setBrowserOverlayVisible(tabId, visible) {
  try {
    await runInTab(tabId, buildOverlayVisibilityScript(visible));
  } catch {
    // Best-effort for clean screenshots.
  }
}

async function flashHighlight(id, ref, label, kind = 'move') {
  if (!shouldAnimateOverlay()) return null;
  try {
    // Outline the element (without duplicating the old blue badge when our live pill is active).
    const { result } = await runInTab(id, highlightScript(ref, '', true));
    const readable = result?.name ? `${label}「${result.name.slice(0, 24)}」` : `${label} ${ref}`;
    const cursor = await showBrowserCursorAction(id, { ref, label: readable, kind });
    await sleep(VISUAL_GLIDE_MS);
    return { element: result, cursor };
  } catch {
    return null;
  }
}

async function getElementRect(tabId, ref) {
  const target = String(ref || '').trim();
  if (!target) return null;
  const { result } = await runInTab(tabId, `(() => {
    ${FIND_REF_HELPER}
    const el = findPiRef(${JSON.stringify(target)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      x: Math.max(0, Math.round(r.left)),
      y: Math.max(0, Math.round(r.top)),
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
    };
  })()`);
  return result || null;
}

async function clickBrowserRef(tabId, ref, options = {}) {
  const target = String(ref || '').trim();
  if (!target) throw new Error('需要 ref（先 browser_snapshot）');
  const doubleClick = options.doubleClick === true;
  const buttonName = ['left', 'right', 'middle'].includes(String(options.button || '').toLowerCase())
    ? String(options.button).toLowerCase()
    : 'left';
  const buttonIndex = buttonName === 'right' ? 2 : buttonName === 'middle' ? 1 : 0;
  const actionLabel = doubleClick ? '双击' : buttonName === 'right' ? '右键点击' : '点击';
  return withTabAction(tabId, 'act', async (id) => {
    await flashHighlight(id, target, options.label || actionLabel, 'click');
    const { entry, result } = await runInTab(id, `(() => {
      ${FIND_REF_HELPER}
      const el = findPiRef(${JSON.stringify(target)});
      if (!el) return { ok: false, error: '找不到元素，请重新 snapshot' };
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const cx = rect.left + Math.min(rect.width / 2, Math.max(4, rect.width - 4));
      const cy = rect.top + Math.min(rect.height / 2, Math.max(4, rect.height - 4));
      const btn = ${buttonIndex};
      const dbl = ${doubleClick ? 'true' : 'false'};
      const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: btn, buttons: btn === 2 ? 2 : btn === 1 ? 4 : 1 };
      el.dispatchEvent(new PointerEvent('pointerover', opts));
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      if (typeof el.focus === 'function') el.focus();
      if (btn === 2) {
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('contextmenu', opts));
      } else {
        if (typeof el.click === 'function') el.click();
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        if (dbl) {
          el.dispatchEvent(new MouseEvent('mousedown', { ...opts, detail: 2 }));
          if (typeof el.click === 'function') el.click();
          el.dispatchEvent(new MouseEvent('mouseup', { ...opts, detail: 2 }));
          el.dispatchEvent(new MouseEvent('dblclick', { ...opts, detail: 2 }));
        }
      }
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        name: String(el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 80),
        x: Math.round(cx),
        y: Math.round(cy),
      };
    })()`);
    if (!result?.ok) throw new Error(result?.error || '点击失败');
    return {
      ok: true,
      tabId: entry.id,
      url: entry.url,
      ref: target,
      button: buttonName,
      doubleClick,
      element: result,
      snapshot: await maybeSnapshot(entry, options.snapshot),
    };
  }, { action: 'click', label: `${actionLabel} ${target}` });
}

async function hoverBrowserRef(tabId, ref, options = {}) {
  const target = String(ref || '').trim();
  if (!target) throw new Error('需要 ref（先 browser_snapshot）');
  return withTabAction(tabId, 'act', async (id) => {
    await flashHighlight(id, target, options.label || '悬停', 'move');
    const { entry, contents, result } = await runInTab(id, `(() => {
      ${FIND_REF_HELPER}
      const el = findPiRef(${JSON.stringify(target)});
      if (!el) return { ok: false, error: '找不到元素，请重新 snapshot' };
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const cx = rect.left + Math.min(rect.width / 2, Math.max(4, rect.width - 4));
      const cy = rect.top + Math.min(rect.height / 2, Math.max(4, rect.height - 4));
      const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
      el.dispatchEvent(new PointerEvent('pointerover', opts));
      el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
      el.dispatchEvent(new PointerEvent('pointermove', opts));
      el.dispatchEvent(new MouseEvent('mousemove', opts));
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        name: String(el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 80),
        x: Math.round(cx),
        y: Math.round(cy),
      };
    })()`);
    if (!result?.ok) throw new Error(result?.error || '悬停失败');
    // Also send a real Chromium mouseMove so CSS :hover selectors genuinely activate.
    try {
      if (typeof contents.sendInputEvent === 'function') {
        contents.sendInputEvent({ type: 'mouseMove', x: result.x, y: result.y });
      }
    } catch {
      // Fallback JS events already fired.
    }
    return {
      ok: true,
      tabId: entry.id,
      url: entry.url,
      ref: target,
      element: result,
      snapshot: await maybeSnapshot(entry, options.snapshot),
    };
  }, { action: 'hover', label: `悬停 ${target}` });
}

async function typeBrowserRef(tabId, ref, text, options = {}) {
  const target = String(ref || '').trim();
  const value = String(text ?? '');
  if (value.length > 20_000) throw new Error('输入过长');
  const clear = options.clear !== false;
  const submit = options.submit === true;
  const preview = value.length > 20 ? `${value.slice(0, 20)}…` : value;
  const label = options.label || (preview ? `输入「${preview}」` : '输入文本');
  return withTabAction(tabId, 'act', async (id) => {
    if (target) {
      await flashHighlight(id, target, label, 'click');
    } else {
      // Glide the live cursor onto the currently focused input with a click ripple.
      try {
        const { result: box } = await runInTab(id, `(() => {
          let el = document.activeElement;
          while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
          if (!el || el === document.body || el === document.documentElement) return null;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 && r.height <= 0) return null;
          return { x: Math.round(r.left + Math.min(r.width / 2, Math.max(12, r.width - 12))), y: Math.round(r.top + r.height / 2) };
        })()`);
        await showBrowserCursorAction(id, {
          label,
          kind: 'click',
          ...(box ? { x: box.x, y: box.y } : {}),
        });
        if (shouldAnimateOverlay()) await sleep(160);
      } catch {
        await showBrowserCursorAction(id, { label, kind: 'click' });
      }
    }
    const { entry, result } = await runInTab(id, `(async () => {
      ${FIND_REF_HELPER}
      const targetRef = ${JSON.stringify(target)};
      let el = null;
      if (targetRef) {
        el = findPiRef(targetRef);
        if (!el) return { ok: false, error: '找不到元素，请重新 snapshot' };
      } else {
        el = document.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) {
          el = el.shadowRoot.activeElement;
        }
        if (!el || el === document.body || el === document.documentElement) {
          return { ok: false, error: '当前没有已聚焦的输入框，请先点击输入框或提供 ref' };
        }
      }
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      if (typeof el.focus === 'function') el.focus();
      const text = ${JSON.stringify(value)};
      const clear = ${clear ? 'true' : 'false'};
      const animate = ${shouldAnimateOverlay() ? 'true' : 'false'};
      const chars = Array.from(text);
      const stepSize = chars.length <= 28 ? 1 : Math.max(2, Math.ceil(chars.length / 22));
      const delayMs = animate && chars.length > 1 ? Math.min(26, Math.max(12, Math.round(420 / Math.ceil(chars.length / stepSize)))) : 0;
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      if (el.isContentEditable) {
        if (clear) el.textContent = '';
        if (delayMs > 0) {
          for (let i = 0; i < chars.length; i += stepSize) {
            const chunk = chars.slice(i, i + stepSize).join('');
            el.textContent = (el.textContent || '') + chunk;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: chunk, inputType: 'insertText' }));
            if (i + stepSize < chars.length) await pause(delayMs);
          }
        } else {
          el.textContent = (el.textContent || '') + text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        }
      } else if ('value' in el) {
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        const setter = descriptor && descriptor.set;
        const setVal = (next) => {
          if (setter) setter.call(el, next);
          else el.value = next;
        };
        let current = clear ? '' : String(el.value || '');
        if (clear) {
          setVal('');
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (delayMs > 0) {
          for (let i = 0; i < chars.length; i += stepSize) {
            const chunk = chars.slice(i, i + stepSize).join('');
            current += chunk;
            setVal(current);
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: chunk, inputType: 'insertText' }));
            if (i + stepSize < chars.length) await pause(delayMs);
          }
        } else {
          setVal(current + text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        return { ok: false, error: '该元素不支持输入' };
      }
      if (${submit ? 'true' : 'false'}) {
        // Allow reactive web components / frameworks (Lit, React) to flush the final character before submitting.
        await pause(80);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if ('value' in el && !el.isContentEditable && clear && String(el.value || '') !== text) {
          const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, text);
          else el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          await pause(40);
        }
        const form = typeof el.form !== 'undefined' ? el.form : el.closest('form');
        if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
        else if (form) form.submit();
        else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      }
      const isPassword = el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'password';
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        value: isPassword ? '••••••' : ('value' in el ? String(el.value || '') : String(el.textContent || '')).slice(0, 120),
      };
    })()`);
    if (!result?.ok) throw new Error(result?.error || '输入失败');
    return {
      ok: true,
      tabId: entry.id,
      url: entry.url,
      ...(target ? { ref: target } : {}),
      element: result,
      snapshot: await maybeSnapshot(entry, options.snapshot),
    };
  }, { action: 'type', label });
}

function parseKeyCombo(combo) {
  const raw = String(combo || '').trim();
  if (!raw) throw new Error('需要指定按键（例如 Escape、Tab、Enter、Shift+Tab、Meta+K）');
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error('按键格式无效');
  const modifiers = [];
  let keyCode = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const mod = parts[i].toLowerCase();
    if (mod === 'shift') modifiers.push('shift');
    else if (mod === 'ctrl' || mod === 'control') modifiers.push('control');
    else if (mod === 'alt' || mod === 'option') modifiers.push('alt');
    else if (mod === 'meta' || mod === 'cmd' || mod === 'command') modifiers.push('meta');
    else if (mod === 'mod') modifiers.push(process.platform === 'darwin' ? 'meta' : 'control');
  }
  const aliases = {
    esc: 'Escape',
    escape: 'Escape',
    return: 'Enter',
    enter: 'Enter',
    tab: 'Tab',
    space: 'Space',
    ' ': 'Space',
    backspace: 'Backspace',
    delete: 'Delete',
    up: 'Up',
    arrowup: 'Up',
    down: 'Down',
    arrowdown: 'Down',
    left: 'Left',
    arrowleft: 'Left',
    right: 'Right',
    arrowright: 'Right',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
  };
  const normalized = aliases[keyCode.toLowerCase()] || keyCode;
  const domKeyMap = {
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Space: ' ',
  };
  return {
    raw,
    keyCode: normalized,
    domKey: domKeyMap[normalized] || normalized,
    modifiers: [...new Set(modifiers)],
  };
}

async function pressBrowserKey(tabId, key, options = {}) {
  const parsed = parseKeyCombo(key);
  const targetRef = String(options.ref || '').trim();
  return withTabAction(tabId, 'act', async (id) => {
    if (targetRef) {
      await flashHighlight(id, targetRef, `按键 ${parsed.raw}`, 'move');
      await runInTab(id, `(() => {
        ${FIND_REF_HELPER}
        const el = findPiRef(${JSON.stringify(targetRef)});
        if (el && typeof el.focus === 'function') el.focus();
      })()`);
    } else {
      await showBrowserCursorAction(id, { label: `按下 ${parsed.raw}`, kind: 'move' });
      if (shouldAnimateOverlay()) await sleep(120);
    }
    const entry = resolveBrowserTab(id);
    const contents = getTabWebContents(entry);
    if (!contents) throw new Error('浏览器标签尚未就绪');
    if (typeof contents.sendInputEvent === 'function') {
      contents.sendInputEvent({
        type: 'keyDown',
        keyCode: parsed.keyCode,
        modifiers: parsed.modifiers,
      });
      if (parsed.keyCode.length === 1 && !parsed.modifiers.includes('control') && !parsed.modifiers.includes('meta')) {
        contents.sendInputEvent({
          type: 'char',
          keyCode: parsed.keyCode,
          modifiers: parsed.modifiers,
        });
      }
      contents.sendInputEvent({
        type: 'keyUp',
        keyCode: parsed.keyCode,
        modifiers: parsed.modifiers,
      });
      await sleep(80);
    } else {
      await runInTab(id, `(() => {
        const target = document.activeElement || document.body || document.documentElement;
        const init = {
          key: ${JSON.stringify(parsed.domKey)},
          bubbles: true,
          cancelable: true,
          shiftKey: ${parsed.modifiers.includes('shift') ? 'true' : 'false'},
          ctrlKey: ${parsed.modifiers.includes('control') ? 'true' : 'false'},
          altKey: ${parsed.modifiers.includes('alt') ? 'true' : 'false'},
          metaKey: ${parsed.modifiers.includes('meta') ? 'true' : 'false'},
        };
        target.dispatchEvent(new KeyboardEvent('keydown', init));
        target.dispatchEvent(new KeyboardEvent('keyup', init));
      })()`);
    }
    return {
      ok: true,
      tabId: entry.id,
      url: entry.url,
      key: parsed.raw,
      modifiers: parsed.modifiers,
      snapshot: await maybeSnapshot(entry, options.snapshot === true),
    };
  }, { action: 'press', label: `按下 ${parsed.raw}` });
}

async function dragBrowserRefs(tabId, sourceRef, targetRef, options = {}) {
  const fromRef = String(sourceRef || '').trim();
  const toRef = String(targetRef || '').trim();
  if (!fromRef || !toRef) throw new Error('拖拽需要提供 sourceRef 和 targetRef');
  return withTabAction(tabId, 'act', async (id) => {
    await flashHighlight(id, fromRef, '开始拖拽', 'drag');
    const { entry, contents, result } = await runInTab(id, `(() => {
      ${FIND_REF_HELPER}
      const src = findPiRef(${JSON.stringify(fromRef)});
      const dst = findPiRef(${JSON.stringify(toRef)});
      if (!src) return { ok: false, error: '找不到拖拽起点元素，请重新 snapshot' };
      if (!dst) return { ok: false, error: '找不到拖拽目标元素，请重新 snapshot' };
      src.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const sr = src.getBoundingClientRect();
      const dr = dst.getBoundingClientRect();
      const sx = Math.round(sr.left + sr.width / 2);
      const sy = Math.round(sr.top + sr.height / 2);
      const dx = Math.round(dr.left + dr.width / 2);
      const dy = Math.round(dr.top + dr.height / 2);
      const dt = typeof DataTransfer !== 'undefined' ? new DataTransfer() : undefined;
      src.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, buttons: 1 }));
      src.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, buttons: 1 }));
      if (dt) src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, dataTransfer: dt }));
      return {
        ok: true,
        sx, sy, dx, dy,
        sourceName: String(src.getAttribute('aria-label') || src.innerText || '').trim().slice(0, 40),
        targetName: String(dst.getAttribute('aria-label') || dst.innerText || '').trim().slice(0, 40),
      };
    })()`);
    if (!result?.ok) throw new Error(result?.error || '拖拽失败');
    await showBrowserCursorAction(id, {
      ref: toRef,
      label: `拖到「${result.targetName || toRef}」`,
      kind: 'drag',
    });
    if (shouldAnimateOverlay()) await sleep(VISUAL_GLIDE_MS);
    try {
      if (typeof contents.sendInputEvent === 'function') {
        contents.sendInputEvent({ type: 'mouseDown', x: result.sx, y: result.sy, button: 'left', clickCount: 1 });
        contents.sendInputEvent({ type: 'mouseMove', x: Math.round((result.sx + result.dx) / 2), y: Math.round((result.sy + result.dy) / 2), modifiers: ['leftButtonDown'] });
        contents.sendInputEvent({ type: 'mouseMove', x: result.dx, y: result.dy, modifiers: ['leftButtonDown'] });
        contents.sendInputEvent({ type: 'mouseUp', x: result.dx, y: result.dy, button: 'left', clickCount: 1 });
      }
    } catch {
      // Continue with DOM drop dispatch.
    }
    await runInTab(id, `(() => {
      ${FIND_REF_HELPER}
      const src = findPiRef(${JSON.stringify(fromRef)});
      const dst = findPiRef(${JSON.stringify(toRef)});
      if (!dst) return;
      const dx = ${result.dx};
      const dy = ${result.dy};
      const dt = typeof DataTransfer !== 'undefined' ? new DataTransfer() : undefined;
      dst.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: dx, clientY: dy, buttons: 1 }));
      dst.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: dx, clientY: dy, buttons: 1 }));
      if (dt) {
        dst.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, clientX: dx, clientY: dy, dataTransfer: dt }));
        dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: dx, clientY: dy, dataTransfer: dt }));
        dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: dx, clientY: dy, dataTransfer: dt }));
      }
      dst.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: dx, clientY: dy }));
      dst.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: dx, clientY: dy }));
      if (src && dt) src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, clientX: dx, clientY: dy, dataTransfer: dt }));
    })()`);
    return {
      ok: true,
      tabId: entry.id,
      url: entry.url,
      sourceRef: fromRef,
      targetRef: toRef,
      snapshot: await maybeSnapshot(entry, options.snapshot),
    };
  }, { action: 'drag', label: `拖拽 ${fromRef} → ${toRef}` });
}

function resolveViewportSpec(options = {}) {
  if (options.reset === true || String(options.preset || '').toLowerCase() === 'reset') {
    return null;
  }
  const presetKey = String(options.preset || '').trim().toLowerCase();
  if (presetKey && Object.hasOwn(VIEWPORT_PRESETS, presetKey)) {
    return { ...VIEWPORT_PRESETS[presetKey] };
  }
  const width = Number(options.width);
  const height = Number(options.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('请提供 width 和 height（像素），或 preset（desktop/laptop/tablet/mobile/reset）');
  }
  const clampedW = Math.min(2560, Math.max(320, Math.round(width)));
  const clampedH = Math.min(1800, Math.max(320, Math.round(height)));
  return { width: clampedW, height: clampedH, label: `${clampedW}×${clampedH}` };
}

async function setBrowserViewport(tabId, options = {}) {
  const spec = resolveViewportSpec(options);
  const label = spec ? `设置视口 ${spec.label}` : '恢复自适应视口';
  return withTabAction(tabId, 'act', async (id) => {
    requestSetBrowserViewport(id, spec);
    await showBrowserCursorAction(id, { label, kind: 'move' });
    await sleep(260);
    const { entry, result } = await runInTab(id, `(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      };
    })()`);
    return {
      ok: true,
      tabId: entry.id,
      url: entry.url,
      viewport: spec,
      actual: result,
    };
  }, { action: 'viewport', label });
}

async function selectBrowserRef(tabId, ref, values, options = {}) {
  const target = String(ref || '').trim();
  if (!target) throw new Error('需要 ref（先 browser_snapshot）');
  const list = Array.isArray(values) ? values.map((item) => String(item)) : [String(values ?? '')];
  if (!list.length || list.every((item) => !item)) throw new Error('需要 values');
  return withTabAction(tabId, 'act', async (id) => {
    await flashHighlight(id, target, options.label || `选择「${list[0]}」`, 'click');
    const { entry, result } = await runInTab(id, `(() => {
      ${FIND_REF_HELPER}
      const el = findPiRef(${JSON.stringify(target)});
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
  }, { action: 'select', label: `选择 ${list.join(', ')}` });
}

async function scrollBrowser(tabId, options = {}) {
  const ref = String(options.ref || '').trim();
  const selector = String(options.selector || '').trim().slice(0, 300);
  const position = ['top', 'bottom'].includes(String(options.position || '').toLowerCase())
    ? String(options.position).toLowerCase()
    : '';
  const direction = String(options.direction || 'down').toLowerCase();
  const dirLabel = position === 'top'
    ? '滚回顶部'
    : position === 'bottom'
      ? '滚到底部'
      : selector
        ? `滚动到 ${selector.slice(0, 24)}`
        : ({ down: '向下滚动', up: '向上滚动', left: '向左滚动', right: '向右滚动' }[direction] || '滚动页面');
  return withTabAction(tabId, 'act', async (id) => {
    const amount = Math.min(4_000, Math.max(1, Number(options.amount) || 600));
    const delta = {
      down: [0, amount],
      up: [0, -amount],
      right: [amount, 0],
      left: [-amount, 0],
    }[direction] || [0, amount];
    if (ref) await flashHighlight(id, ref, '滚动到目标', 'move');
    else {
      const actionText = (position || selector) ? dirLabel : `${dirLabel} ${amount}px`;
      await showBrowserCursorAction(id, { label: actionText, kind: 'move' });
      if (shouldAnimateOverlay()) await sleep(100);
    }
    const { entry, result } = await runInTab(id, `(async () => {
      ${FIND_REF_HELPER}
      const ref = ${JSON.stringify(ref)};
      const selector = ${JSON.stringify(selector)};
      const position = ${JSON.stringify(position)};
      let mode = 'window';
      if (ref) {
        const el = findPiRef(ref);
        if (!el) return { ok: false, error: '找不到元素，请重新 snapshot' };
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        mode = 'ref';
      } else if (selector) {
        let el = null;
        try { el = document.querySelector(selector); } catch { return { ok: false, error: '无效的 selector' }; }
        if (!el) return { ok: false, error: '找不到匹配元素：' + selector };
        el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'smooth' });
        mode = 'selector';
      } else if (position === 'top') {
        window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
        mode = 'top';
      } else if (position === 'bottom') {
        const maxH = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
        window.scrollTo({ top: maxH, behavior: 'smooth' });
        mode = 'bottom';
      } else {
        window.scrollBy({ left: ${delta[0]}, top: ${delta[1]}, behavior: 'smooth' });
      }
      // Wait for smooth scroll animation to settle so reported scrollY is accurate.
      let lastY = Math.round(window.scrollY || 0);
      let stable = 0;
      const deadline = Date.now() + 600;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        const curY = Math.round(window.scrollY || 0);
        if (Math.abs(curY - lastY) <= 1) {
          stable += 1;
          if (stable >= 2) break;
        } else {
          stable = 0;
          lastY = curY;
        }
      }
      return {
        ok: true,
        mode,
        direction: ${JSON.stringify(direction)},
        x: Math.round(window.scrollX || 0),
        y: Math.round(window.scrollY || 0),
        scrollHeight: Math.round(document.documentElement?.scrollHeight || document.body?.scrollHeight || 0),
        viewportHeight: Math.round(window.innerHeight || 0),
      };
    })()`);
    if (!result?.ok) throw new Error(result?.error || '滚动失败');
    return { ok: true, tabId: entry.id, url: entry.url, ...result };
  }, { action: 'scroll', label: ref ? `滚动到 ${ref}` : dirLabel });
}

async function waitBrowser(tabId, options = {}) {
  const timeoutMs = Math.min(60_000, Math.max(100, Number(options.timeoutMs) || 10_000));
  const ref = String(options.ref || '').trim();
  const urlIncludes = String(options.urlIncludes || '').trim();
  const textIncludes = String(options.textIncludes || '').trim();
  const waitDesc = textIncludes
    ? `等待「${textIncludes.slice(0, 24)}」`
    : urlIncludes
      ? `等待跳转 ${urlIncludes.slice(0, 28)}`
      : `等待元素 ${ref}`;
  return withTabAction(tabId, 'wait', async (id) => {
    await showBrowserCursorAction(id, { label: waitDesc, kind: 'move', idleMs: Math.min(timeoutMs + 1000, 12_000) });
    const started = Date.now();
    let lastError = '等待超时';
    while (Date.now() - started < timeoutMs) {
      const { entry, result } = await runInTab(id, `(() => {
        ${FIND_REF_HELPER}
        const ref = ${JSON.stringify(ref)};
        const urlIncludes = ${JSON.stringify(urlIncludes)};
        const textIncludes = ${JSON.stringify(textIncludes)};
        if (ref) {
          const el = findPiRef(ref);
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
        if (ref) await flashHighlight(id, ref, '已出现', 'move');
        return {
          ok: true,
          tabId: entry.id,
          url: result.url || entry.url,
          title: result.title || entry.title,
          waitedMs: Date.now() - started,
        };
      }
      lastError = result?.error || lastError;
      await sleep(200);
    }
    throw new Error(`${lastError}（${timeoutMs}ms）`);
  }, { action: 'wait', label: waitDesc });
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
  }, { action: 'dialog', label: accept ? '确认对话框' : '取消对话框' });
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
  }, { action: 'evaluate', label: options.note ? `执行脚本：${options.note}` : '执行页面脚本' });
}

module.exports = {
  VIEWPORT_PRESETS,
  clearBrowserHighlights,
  clickBrowserRef,
  dragBrowserRefs,
  evaluateBrowserScript,
  getElementRect,
  handleBrowserDialog,
  highlightBrowserRef,
  hoverBrowserRef,
  installDialogBridge,
  listBrowserDialogs,
  parseKeyCombo,
  pressBrowserKey,
  resolveViewportSpec,
  scrollBrowser,
  selectBrowserRef,
  setBrowserOverlayVisible,
  setBrowserViewport,
  showBrowserCursorAction,
  typeBrowserRef,
  waitBrowser,
};
