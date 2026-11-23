/**
 * Build a bounded page snapshot for Agent read tools.
 * Runs inside the guest via executeJavaScript; keep the script self-contained.
 * Stamps data-pi-ref on visited elements so act tools can target them.
 */

const DEFAULT_MAX_CHARS = 12_000;
const MAX_NODES = 400;
const SNAPSHOT_MODES = new Set(['dom_lite', 'a11y']);

function buildSnapshotScript(options = {}) {
  const maxNodes = Math.min(800, Math.max(50, Number(options.maxNodes) || MAX_NODES));
  const mode = SNAPSHOT_MODES.has(String(options.mode || '').toLowerCase())
    ? String(options.mode).toLowerCase()
    : 'dom_lite';
  const includeIframes = options.includeIframes !== false;
  return `(() => {
  const maxNodes = ${maxNodes};
  const mode = ${JSON.stringify(mode)};
  const includeIframes = ${includeIframes ? 'true' : 'false'};
  const interesting = new Set([
    'a', 'button', 'input', 'textarea', 'select', 'option', 'label',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'summary',
    'img', 'nav', 'main', 'header', 'footer', 'form', 'section', 'article',
  ]);
  const refs = {};
  const tree = [];
  const warnings = [];
  let count = 0;
  let omitted = 0;
  let stamped = 0;

  function clearOldMarks(root) {
    try {
      root.querySelectorAll('[data-pi-ref]').forEach((el) => el.removeAttribute('data-pi-ref'));
    } catch {
      // Cross-origin or detached roots can throw.
    }
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const type = String(el.type || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'file') return 'button';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'img') return 'image';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (tag === 'label') return 'label';
    if (tag === 'li') return 'listitem';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'table') return 'table';
    return tag;
  }

  function nameOf(el) {
    const labelled = el.getAttribute('aria-label')
      || el.getAttribute('alt')
      || el.getAttribute('title')
      || el.getAttribute('placeholder')
      || '';
    if (labelled) return labelled.trim().slice(0, 120);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const id = el.getAttribute('id');
      if (id) {
        try {
          const esc = (typeof CSS !== 'undefined' && CSS.escape)
            ? CSS.escape(id)
            : String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const label = document.querySelector('label[for="' + esc + '"]');
          if (label) {
            const text = (label.innerText || label.textContent || '').replace(/\\s+/g, ' ').trim();
            if (text) return text.slice(0, 120);
          }
        } catch {
          // ignore
        }
      }
    }
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return text.slice(0, 120);
  }

  function valueOf(el) {
    if (el.tagName === 'INPUT' && (el.type === 'password' || el.type === 'hidden')) return '';
    if ('value' in el && typeof el.value === 'string') return el.value.slice(0, 120);
    return '';
  }

  function visible(el) {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch {
      return false;
    }
  }

  function stamp(el, ref) {
    try {
      el.setAttribute('data-pi-ref', ref);
      stamped += 1;
    } catch {
      // ignore
    }
  }

  function a11yInteresting(el) {
    const role = roleOf(el);
    const tag = el.tagName.toLowerCase();
    if (interesting.has(tag)) return true;
    if (el.getAttribute('role')) return true;
    if (el.tabIndex >= 0) return true;
    if (el.isContentEditable) return true;
    if (['link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab', 'switch'].includes(role)) {
      return true;
    }
    const name = nameOf(el);
    if (mode === 'a11y' && name && ['heading', 'navigation', 'main', 'form', 'img', 'image', 'listitem'].includes(role)) {
      return true;
    }
    return false;
  }

  function walk(el, depth, framePath) {
    if (!el || el.nodeType !== 1 || depth > 14) return null;
    if (count >= maxNodes) { omitted += 1; return null; }
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg' || tag === 'path' || tag === 'meta' || tag === 'link') {
      return null;
    }

    if (tag === 'iframe') {
      if (!includeIframes) {
        warnings.push('iframe:skipped');
        return null;
      }
      let childDoc = null;
      try {
        childDoc = el.contentDocument;
      } catch {
        childDoc = null;
      }
      if (!childDoc || !childDoc.documentElement) {
        warnings.push('iframe:cross-origin omitted');
        if (count >= maxNodes) { omitted += 1; return null; }
        count += 1;
        const ref = 'e' + count;
        stamp(el, ref);
        const name = nameOf(el) || el.getAttribute('src') || 'iframe';
        refs[ref] = {
          role: 'iframe',
          name: String(name).slice(0, 120),
          tag: 'iframe',
          frame: framePath || 'top',
          crossOrigin: true,
        };
        return { ref, role: 'iframe', name: refs[ref].name };
      }
      if (count >= maxNodes) { omitted += 1; return null; }
      count += 1;
      const ref = 'e' + count;
      stamp(el, ref);
      const frameName = nameOf(el) || el.getAttribute('name') || el.getAttribute('src') || ('frame-' + count);
      refs[ref] = {
        role: 'iframe',
        name: String(frameName).slice(0, 120),
        tag: 'iframe',
        frame: framePath || 'top',
      };
      const nextPath = (framePath || 'top') + '/' + ref;
      const body = childDoc.body || childDoc.documentElement;
      clearOldMarks(childDoc);
      const child = walk(body, 0, nextPath);
      return {
        ref,
        role: 'iframe',
        name: refs[ref].name,
        ...(child ? { children: [child] } : {}),
      };
    }

    const keep = mode === 'a11y' ? a11yInteresting(el) : (interesting.has(tag) || Boolean(el.getAttribute('role')));
    if (!keep && depth > 0) {
      const kids = [];
      for (const child of el.children) {
        const node = walk(child, depth + 1, framePath);
        if (node) kids.push(node);
      }
      if (kids.length === 1) return kids[0];
      if (kids.length > 1) return { role: 'group', children: kids };
      return null;
    }

    if (!visible(el) && depth > 0 && tag !== 'option') return null;

    count += 1;
    const ref = 'e' + count;
    stamp(el, ref);
    const role = roleOf(el);
    const name = nameOf(el);
    const value = valueOf(el);
    const states = [];
    if (el.disabled) states.push('disabled');
    if (el.checked) states.push('checked');
    if (el.readOnly) states.push('readonly');
    if (el.getAttribute('aria-expanded') === 'true') states.push('expanded');
    if (el.getAttribute('aria-pressed') === 'true') states.push('pressed');
    if (el.getAttribute('aria-selected') === 'true') states.push('selected');
    if (mode === 'a11y' && el.getAttribute('aria-required') === 'true') states.push('required');

    refs[ref] = {
      role,
      name,
      ...(value ? { value } : {}),
      ...(states.length ? { states } : {}),
      tag,
      ...(framePath && framePath !== 'top' ? { frame: framePath } : {}),
    };

    const children = [];
    for (const child of el.children) {
      const node = walk(child, depth + 1, framePath);
      if (node) children.push(node);
    }
    return {
      ref,
      role,
      name,
      ...(children.length ? { children } : {}),
    };
  }

  clearOldMarks(document);
  const rootEl = document.body || document.documentElement;
  const root = walk(rootEl, 0, 'top');
  if (root) tree.push(root);
  return {
    url: location.href,
    title: document.title || '',
    mode,
    refs,
    tree,
    omittedCount: omitted,
    nodeCount: count,
    stampedCount: stamped,
    warnings: Array.from(new Set(warnings)),
  };
})()`;
}

// Keep a default script export for older tests that inspect SNAPSHOT_SCRIPT.
const SNAPSHOT_SCRIPT = buildSnapshotScript({ mode: 'dom_lite', maxNodes: MAX_NODES });

function trimSnapshot(snapshot, maxChars = DEFAULT_MAX_CHARS) {
  const base = {
    url: snapshot.url || '',
    title: snapshot.title || '',
    mode: snapshot.mode || 'dom_lite',
    truncated: false,
    omittedCount: Number(snapshot.omittedCount) || 0,
    stampedCount: Number(snapshot.stampedCount) || 0,
    refs: snapshot.refs || {},
    tree: snapshot.tree || [],
    warnings: Array.isArray(snapshot.warnings) ? [...snapshot.warnings] : [],
  };
  let text = JSON.stringify(base);
  if (text.length <= maxChars) return { ...base, charCount: text.length };
  const compact = structuredClone(base);
  function prune(nodes, depth) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (depth >= 2) delete node.children;
      else if (node.children) prune(node.children, depth + 1);
      if (typeof node.name === 'string' && node.name.length > 40) node.name = `${node.name.slice(0, 37)}...`;
    }
  }
  prune(compact.tree, 0);
  for (const ref of Object.values(compact.refs)) {
    if (typeof ref.name === 'string' && ref.name.length > 40) ref.name = `${ref.name.slice(0, 37)}...`;
    if (typeof ref.value === 'string' && ref.value.length > 40) ref.value = `${ref.value.slice(0, 37)}...`;
  }
  text = JSON.stringify(compact);
  if (text.length <= maxChars) {
    return {
      ...compact,
      truncated: true,
      charCount: text.length,
      warnings: [...compact.warnings, 'snapshot compacted to fit size budget'],
    };
  }
  let keys = Object.keys(compact.refs).slice(0, 80);
  const slim = {
    url: compact.url,
    title: compact.title,
    mode: compact.mode,
    truncated: true,
    omittedCount: compact.omittedCount + Math.max(0, Object.keys(compact.refs).length - keys.length),
    stampedCount: compact.stampedCount,
    refs: {},
    tree: compact.tree.slice(0, 20),
    warnings: [...compact.warnings, 'snapshot truncated to fit size budget'],
  };
  for (const key of keys) slim.refs[key] = compact.refs[key];
  text = JSON.stringify(slim);
  while (text.length > maxChars && slim.tree.length > 0) {
    slim.tree.pop();
    text = JSON.stringify(slim);
  }
  while (text.length > maxChars && keys.length > 0) {
    keys = keys.slice(0, Math.max(0, keys.length - 10));
    slim.refs = {};
    for (const key of keys) slim.refs[key] = compact.refs[key];
    slim.omittedCount = compact.omittedCount + Math.max(0, Object.keys(compact.refs).length - keys.length);
    text = JSON.stringify(slim);
  }
  if (text.length > maxChars) {
    slim.refs = {};
    slim.tree = [];
    slim.warnings = [...slim.warnings, 'snapshot reduced to metadata only'];
    text = JSON.stringify(slim);
  }
  return { ...slim, charCount: text.length };
}

async function captureBrowserSnapshot(contents, options = {}) {
  if (!contents || contents.isDestroyed()) throw new Error('浏览器标签尚未就绪');
  const maxChars = Math.min(40_000, Math.max(2_000, Number(options.maxChars) || DEFAULT_MAX_CHARS));
  const mode = SNAPSHOT_MODES.has(String(options.mode || '').toLowerCase())
    ? String(options.mode).toLowerCase()
    : 'dom_lite';
  const script = buildSnapshotScript({
    mode,
    maxNodes: options.maxNodes,
    includeIframes: options.includeIframes,
  });
  const raw = await contents.executeJavaScript(script, true);
  const snapshot = trimSnapshot(raw && typeof raw === 'object' ? raw : {}, maxChars);
  if (raw?.url && !snapshot.url) snapshot.url = raw.url;
  snapshot.mode = mode;
  return snapshot;
}

const MAX_SCREENSHOT_BYTES = 1_200_000;

async function captureBrowserScreenshot(contents, options = {}) {
  if (!contents || contents.isDestroyed()) throw new Error('浏览器标签尚未就绪');
  const image = await contents.capturePage();
  if (!image || image.isEmpty()) throw new Error('无法截取当前页面');
  let working = image;
  let encoded = working.toJPEG(82);
  for (let attempt = 0; attempt < 5 && encoded.length > MAX_SCREENSHOT_BYTES; attempt += 1) {
    const size = working.getSize();
    const scale = attempt === 0 ? 0.75 : 0.7;
    working = working.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good',
    });
    encoded = working.toJPEG(78 - attempt * 4);
  }
  if (!encoded.length || encoded.length > MAX_SCREENSHOT_BYTES * 1.5) {
    throw new Error('截图过大，请缩小窗口或滚动到关键区域后再试');
  }
  return {
    mimeType: 'image/jpeg',
    data: encoded.toString('base64'),
    width: working.getSize().width,
    height: working.getSize().height,
    fullPage: Boolean(options.fullPage),
  };
}

module.exports = {
  DEFAULT_MAX_CHARS,
  MAX_NODES,
  MAX_SCREENSHOT_BYTES,
  SNAPSHOT_MODES,
  SNAPSHOT_SCRIPT,
  buildSnapshotScript,
  captureBrowserSnapshot,
  captureBrowserScreenshot,
  trimSnapshot,
};
