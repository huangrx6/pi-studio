/**
 * Build a bounded page snapshot for Agent read tools.
 * Runs inside the guest via executeJavaScript; keep the script self-contained.
 * Stamps data-pi-ref on visited elements so act tools can target them.
 *
 * Supports:
 * - mode: 'dom_lite' (default) | 'a11y' | 'text'
 * - viewportOnly: focus on elements visible in the current viewport
 * - selector: optional CSS selector scoping the snapshot subtree
 * - open Shadow DOM + same-origin iframe traversal
 */

const DEFAULT_MAX_CHARS = 12_000;
const MAX_NODES = 400;
const SNAPSHOT_MODES = new Set(['dom_lite', 'a11y', 'text']);

function buildTextSnapshotScript(options = {}) {
  const maxChars = Math.min(40_000, Math.max(1_000, Number(options.maxChars) || DEFAULT_MAX_CHARS));
  const viewportOnly = options.viewportOnly === true;
  const selector = typeof options.selector === 'string' ? options.selector.trim().slice(0, 300) : '';
  return `(() => {
  const maxChars = ${maxChars};
  const viewportOnly = ${viewportOnly ? 'true' : 'false'};
  const selector = ${JSON.stringify(selector)};
  const warnings = [];
  const docEl = document.documentElement;
  const vw = Math.max(1, window.innerWidth || docEl?.clientWidth || 0);
  const vh = Math.max(1, window.innerHeight || docEl?.clientHeight || 0);
  const scroll = {
    x: Math.round(window.scrollX || 0),
    y: Math.round(window.scrollY || 0),
    width: Math.round((docEl?.scrollWidth || document.body?.scrollWidth || vw)),
    height: Math.round((docEl?.scrollHeight || document.body?.scrollHeight || vh)),
    viewportWidth: Math.round(vw),
    viewportHeight: Math.round(vh),
  };

  let root = null;
  if (selector) {
    try { root = document.querySelector(selector); } catch { warnings.push('invalid selector'); }
    if (!root) warnings.push('selector not found: ' + selector);
  }
  if (!root) {
    root = document.querySelector('main, article, [role="main"]') || document.body || docEl;
  }
  if (!root) {
    return { url: location.href, title: document.title || '', mode: 'text', text: '', scroll, warnings, refs: {}, tree: [], omittedCount: 0, nodeCount: 0, stampedCount: 0 };
  }

  function isVisible(el) {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (viewportOnly) {
        if (rect.bottom < -40 || rect.top > vh + 40 || rect.right < -40 || rect.left > vw + 40) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function cleanText(raw) {
    return String(raw || '').replace(/\\s+/g, ' ').trim();
  }

  function formatTable(table) {
    const rows = Array.from(table.querySelectorAll('tr')).slice(0, 60);
    if (!rows.length) return '';
    const lines = [];
    rows.forEach((tr, rowIndex) => {
      const cells = Array.from(tr.children)
        .filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
        .map((cell) => cleanText(cell.innerText || cell.textContent || '').replace(/\\|/g, '/').slice(0, 80));
      if (!cells.length) return;
      lines.push('| ' + cells.join(' | ') + ' |');
      if (rowIndex === 0) {
        lines.push('| ' + cells.map(() => '---').join(' | ') + ' |');
      }
    });
    return lines.join('\\n');
  }

  const blocks = [];
  let charTotal = 0;
  let truncated = false;
  const skipTags = new Set(['script', 'style', 'noscript', 'svg', 'canvas', 'template', 'nav', 'aside', 'footer']);

  function pushBlock(line) {
    if (!line || truncated) return;
    if (charTotal + line.length + 2 > maxChars) {
      const remaining = Math.max(0, maxChars - charTotal - 20);
      if (remaining > 40) blocks.push(line.slice(0, remaining) + '...');
      truncated = true;
      warnings.push('text truncated to fit size budget');
      return;
    }
    blocks.push(line);
    charTotal += line.length + 2;
  }

  function walkText(node) {
    if (!node || node.nodeType !== 1 || truncated) return;
    const tag = node.tagName.toLowerCase();
    if (tag !== 'main' && tag !== 'article' && skipTags.has(tag) && node !== root) return;
    if (!isVisible(node) && node !== root) return;

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]) || 2;
      const text = cleanText(node.innerText || node.textContent || '');
      if (text) pushBlock('#'.repeat(level) + ' ' + text);
      return;
    }
    if (tag === 'table') {
      const md = formatTable(node);
      if (md) pushBlock(md);
      return;
    }
    if (tag === 'pre') {
      const code = String(node.innerText || node.textContent || '').trim().slice(0, 1200);
      if (code) pushBlock('\`\`\`\\n' + code + '\\n\`\`\`');
      return;
    }
    if (tag === 'p' || tag === 'li' || tag === 'blockquote' || tag === 'dt' || tag === 'dd') {
      const hasBlockChild = node.querySelector && node.querySelector('table, pre, ul, ol, h1, h2, h3, h4, h5, h6');
      if (!hasBlockChild) {
        const text = cleanText(node.innerText || node.textContent || '');
        if (text) pushBlock(tag === 'li' ? '- ' + text : text);
        return;
      }
    }

    const kids = [];
    if (node.shadowRoot) {
      for (const child of node.shadowRoot.children) kids.push(child);
    }
    for (const child of node.children) kids.push(child);
    if (!kids.length) {
      const text = cleanText(node.innerText || node.textContent || '');
      if (text) pushBlock(text);
      return;
    }
    for (const child of kids) {
      walkText(child);
      if (truncated) break;
    }
  }

  walkText(root);
  if (!blocks.length) {
    const fallback = cleanText(root.innerText || root.textContent || '');
    if (fallback) pushBlock(fallback.slice(0, maxChars));
  }

  return {
    url: location.href,
    title: document.title || '',
    mode: 'text',
    text: blocks.join('\\n\\n'),
    truncated,
    scroll,
    refs: {},
    tree: [],
    omittedCount: 0,
    nodeCount: blocks.length,
    stampedCount: 0,
    warnings: Array.from(new Set(warnings)),
  };
})()`;
}

function buildSnapshotScript(options = {}) {
  const mode = SNAPSHOT_MODES.has(String(options.mode || '').toLowerCase())
    ? String(options.mode).toLowerCase()
    : 'dom_lite';
  if (mode === 'text') {
    return buildTextSnapshotScript(options);
  }
  const maxNodes = Math.min(800, Math.max(50, Number(options.maxNodes) || MAX_NODES));
  const includeIframes = options.includeIframes !== false;
  const viewportOnly = options.viewportOnly === true;
  const selector = typeof options.selector === 'string' ? options.selector.trim().slice(0, 300) : '';
  return `(() => {
  const maxNodes = ${maxNodes};
  const mode = ${JSON.stringify(mode)};
  const includeIframes = ${includeIframes ? 'true' : 'false'};
  const viewportOnly = ${viewportOnly ? 'true' : 'false'};
  const selector = ${JSON.stringify(selector)};
  const interesting = new Set([
    'a', 'button', 'input', 'textarea', 'select', 'option', 'label',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'summary',
    'img', 'nav', 'main', 'header', 'footer', 'form', 'section', 'article',
  ]);
  const interactiveTags = new Set(['a', 'button', 'input', 'textarea', 'select', 'option', 'summary']);
  const refs = {};
  const tree = [];
  const warnings = [];
  let count = 0;
  let omitted = 0;
  let stamped = 0;

  const docEl = document.documentElement;
  const vw = Math.max(1, window.innerWidth || docEl?.clientWidth || 0);
  const vh = Math.max(1, window.innerHeight || docEl?.clientHeight || 0);
  const scroll = {
    x: Math.round(window.scrollX || 0),
    y: Math.round(window.scrollY || 0),
    width: Math.round(docEl?.scrollWidth || document.body?.scrollWidth || vw),
    height: Math.round(docEl?.scrollHeight || document.body?.scrollHeight || vh),
    viewportWidth: Math.round(vw),
    viewportHeight: Math.round(vh),
  };

  function clearOldMarks(root) {
    try {
      root.querySelectorAll('[data-pi-ref]').forEach((el) => el.removeAttribute('data-pi-ref'));
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) clearOldMarks(el.shadowRoot);
      }
    } catch {
      // Cross-origin or detached roots can throw.
    }
  }

  function childElementsOf(el) {
    const list = [];
    if (el && el.shadowRoot) {
      for (const child of el.shadowRoot.children) list.push(child);
    }
    if (el && el.children) {
      for (const child of el.children) list.push(child);
    }
    return list;
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

  function escapeAttrValue(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(String(value));
    }
    return String(value).split('\\\\').join('\\\\\\\\').split('"').join('\\\\"');
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
          const esc = escapeAttrValue(id);
          const root = el.getRootNode && el.getRootNode().querySelector ? el.getRootNode() : document;
          const label = root.querySelector('label[for="' + esc + '"]');
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

  function isHiddenSubtree(el) {
    try {
      if (el.hidden) return true;
      const tag = el.tagName.toLowerCase();
      if (tag === 'dialog' && !el.open) return true;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      return false;
    } catch {
      return false;
    }
  }

  function boxOf(el) {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return rect;
    } catch {
      return null;
    }
  }

  function inViewport(rect) {
    if (!rect) return false;
    return rect.bottom >= -40 && rect.top <= vh + 40 && rect.right >= -40 && rect.left <= vw + 40;
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
    if (!el || el.nodeType !== 1 || depth > 24) return null;
    if (count >= maxNodes) { omitted += 1; return null; }
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg' || tag === 'path' || tag === 'meta' || tag === 'link') {
      return null;
    }
    if (el.id === 'pi-agent-overlay-root' || el.id === 'pi-browser-highlight-label') {
      return null;
    }
    if (depth > 0 && tag !== 'option' && isHiddenSubtree(el)) {
      return null;
    }

    if (tag === 'iframe') {
      if (!includeIframes) {
        warnings.push('iframe:skipped');
        return null;
      }
      const rect = boxOf(el);
      if (viewportOnly && depth > 0 && !inViewport(rect)) return null;
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

    const rect = boxOf(el);
    const kidsRaw = childElementsOf(el);
    // Do not prune 0x0 wrappers (display:contents, custom-element modal hosts, portals) — walk their children/shadowRoot.
    if (!rect && depth > 0 && tag !== 'option') {
      if (!kidsRaw.length) return null;
      const kids = [];
      for (const child of kidsRaw) {
        const node = walk(child, depth + 1, framePath);
        if (node) kids.push(node);
      }
      if (kids.length === 1) return kids[0];
      if (kids.length > 1) return { role: 'group', children: kids };
      return null;
    }

    const keep = mode === 'a11y'
      ? a11yInteresting(el)
      : (interesting.has(tag) || tag === 'dialog' || Boolean(el.getAttribute('role')) || el.tabIndex >= 0 || el.isContentEditable);

    // When viewportOnly is enabled, still traverse through containers so on-screen descendants are captured.
    const onScreen = !viewportOnly || depth === 0 || tag === 'option' || inViewport(rect);
    if (!keep && depth > 0) {
      const kids = [];
      for (const child of kidsRaw) {
        const node = walk(child, depth + 1, framePath);
        if (node) kids.push(node);
      }
      if (kids.length === 1) return kids[0];
      if (kids.length > 1) return { role: 'group', children: kids };
      return null;
    }

    if (!onScreen) {
      if (interactiveTags.has(tag) || !kidsRaw.length) return null;
      const kids = [];
      for (const child of kidsRaw) {
        const node = walk(child, depth + 1, framePath);
        if (node) kids.push(node);
      }
      if (kids.length === 1) return kids[0];
      if (kids.length > 1) return { role: 'group', children: kids };
      return null;
    }

    const children = [];
    const role = roleOf(el);
    const isContainerOnly = ['body', 'nav', 'main', 'header', 'footer', 'section', 'article', 'form', 'list', 'group'].includes(role)
      || ['body', 'nav', 'main', 'header', 'footer', 'section', 'article', 'form'].includes(tag);

    // Reserve ref budget for leaf/interactive/heading elements before wrapping containers when viewportOnly.
    if (viewportOnly && isContainerOnly && depth > 0 && kidsRaw.length > 0) {
      for (const child of kidsRaw) {
        const node = walk(child, depth + 1, framePath);
        if (node) children.push(node);
      }
      if (!children.length) return null;
      if (children.length === 1) return children[0];
      return { role, children };
    }

    count += 1;
    const ref = 'e' + count;
    stamp(el, ref);
    const name = isContainerOnly ? (el.getAttribute('aria-label') || '') : nameOf(el);
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

    for (const child of kidsRaw) {
      const node = walk(child, depth + 1, framePath);
      if (node) children.push(node);
    }
    return {
      ref,
      role,
      name,
      ...(value ? { value } : {}),
      ...(states.length ? { states } : {}),
      ...(children.length ? { children } : {}),
    };
  }

  clearOldMarks(document);
  let rootEl = null;
  if (selector) {
    try { rootEl = document.querySelector(selector); } catch { warnings.push('invalid selector'); }
    if (!rootEl) warnings.push('selector not found: ' + selector);
  }
  if (!rootEl) rootEl = document.body || document.documentElement;
  const root = walk(rootEl, 0, 'top');
  if (root) tree.push(root);
  return {
    url: location.href,
    title: document.title || '',
    mode,
    viewportOnly,
    scroll,
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

/**
 * Render a snapshot tree into a compact indented outline (similar to ARIA YAML)
 * so the LLM receives rich structure + ref IDs in ~1/3 the character budget of dual JSON.
 */
function formatSnapshotOutline(snapshot, maxChars = DEFAULT_MAX_CHARS) {
  const refs = snapshot?.refs || {};
  const tree = Array.isArray(snapshot?.tree) ? snapshot.tree : [];
  const lines = [];
  let length = 0;
  let truncated = false;

  function append(line) {
    if (truncated) return false;
    if (length + line.length + 1 > maxChars) {
      truncated = true;
      return false;
    }
    lines.push(line);
    length += line.length + 1;
    return true;
  }

  function visit(node, depth) {
    if (!node || typeof node !== 'object' || truncated) return;
    const indent = '  '.repeat(Math.min(depth, 10));
    const refMeta = node.ref ? refs[node.ref] : null;
    const role = node.role || refMeta?.role || 'group';
    const rawName = typeof node.name === 'string' && node.name ? node.name : (refMeta?.name || '');
    const name = rawName ? rawName.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
    const value = typeof node.value === 'string' && node.value ? node.value : (refMeta?.value || '');
    const states = Array.isArray(node.states) && node.states.length
      ? node.states
      : (Array.isArray(refMeta?.states) ? refMeta.states : []);

    // Collapse anonymous wrapper groups to save indentation and tokens.
    if (!node.ref && role === 'group' && !name && Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child, depth);
        if (truncated) return;
      }
      return;
    }

    const parts = [`${indent}- ${role}`];
    if (name) parts.push(JSON.stringify(name));
    if (node.ref) parts.push(`[${node.ref}]`);
    if (value) parts.push(`val=${JSON.stringify(value.slice(0, 60))}`);
    if (states.length) parts.push(`(${states.join(',')})`);
    if (!append(parts.join(' '))) return;

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child, depth + 1);
        if (truncated) return;
      }
    }
  }

  for (const root of tree) {
    visit(root, 0);
    if (truncated) break;
  }

  if (!lines.length && Object.keys(refs).length > 0) {
    for (const [ref, meta] of Object.entries(refs)) {
      const parts = [`- ${meta.role || 'node'}`];
      if (meta.name) parts.push(JSON.stringify(String(meta.name).slice(0, 100)));
      parts.push(`[${ref}]`);
      if (meta.value) parts.push(`val=${JSON.stringify(String(meta.value).slice(0, 60))}`);
      if (Array.isArray(meta.states) && meta.states.length) parts.push(`(${meta.states.join(',')})`);
      if (!append(parts.join(' '))) break;
    }
  }

  if (truncated) lines.push('... (outline truncated; use viewportOnly: true, selector, or mode: "text" for focused reads)');
  return lines.join('\n');
}

function trimSnapshot(snapshot, maxChars = DEFAULT_MAX_CHARS) {
  const base = {
    url: snapshot.url || '',
    title: snapshot.title || '',
    mode: snapshot.mode || 'dom_lite',
    ...(snapshot.viewportOnly ? { viewportOnly: true } : {}),
    ...(snapshot.scroll ? { scroll: snapshot.scroll } : {}),
    ...(typeof snapshot.text === 'string' ? { text: snapshot.text } : {}),
    truncated: Boolean(snapshot.truncated),
    omittedCount: Number(snapshot.omittedCount) || 0,
    stampedCount: Number(snapshot.stampedCount) || 0,
    refs: snapshot.refs || {},
    tree: snapshot.tree || [],
    warnings: Array.isArray(snapshot.warnings) ? [...snapshot.warnings] : [],
  };
  if (base.mode === 'text') {
    const textBody = String(base.text || '');
    if (textBody.length > maxChars) {
      base.text = `${textBody.slice(0, Math.max(0, maxChars - 24))}...`;
      base.truncated = true;
      base.warnings.push('text truncated to fit size budget');
    }
    return { ...base, charCount: base.text.length };
  }
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
    ...(compact.viewportOnly ? { viewportOnly: true } : {}),
    ...(compact.scroll ? { scroll: compact.scroll } : {}),
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
    maxChars,
    maxNodes: options.maxNodes,
    includeIframes: options.includeIframes,
    viewportOnly: options.viewportOnly === true,
    selector: options.selector,
  });
  const raw = await contents.executeJavaScript(script, true);
  // Keep raw tree/refs intact for outline formatting up to a generous internal budget, then apply outline budget.
  const structuredBudget = mode === 'text' ? maxChars : Math.max(maxChars * 3, 36_000);
  const snapshot = trimSnapshot(raw && typeof raw === 'object' ? raw : {}, structuredBudget);
  if (raw?.url && !snapshot.url) snapshot.url = raw.url;
  snapshot.mode = mode;
  if (mode !== 'text') {
    snapshot.outline = formatSnapshotOutline(snapshot, maxChars);
  }
  return snapshot;
}

const MAX_SCREENSHOT_BYTES = 1_200_000;

async function captureBrowserScreenshot(contents, options = {}) {
  if (!contents || contents.isDestroyed()) throw new Error('浏览器标签尚未就绪');
  const rect = options.rect
    && Number.isFinite(options.rect.width)
    && Number.isFinite(options.rect.height)
    && options.rect.width > 0
    && options.rect.height > 0
    ? {
      x: Math.max(0, Math.round(Number(options.rect.x) || 0)),
      y: Math.max(0, Math.round(Number(options.rect.y) || 0)),
      width: Math.max(1, Math.round(options.rect.width)),
      height: Math.max(1, Math.round(options.rect.height)),
    }
    : undefined;
  const image = rect ? await contents.capturePage(rect) : await contents.capturePage();
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
  captureBrowserScreenshot,
  captureBrowserSnapshot,
  formatSnapshotOutline,
  trimSnapshot,
};
