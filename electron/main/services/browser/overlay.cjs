/**
 * In-page live AI cursor, floating action pill, and click ripple overlay.
 *
 * Runs inside guest pages via executeJavaScript using an isolated Shadow DOM
 * layer with pointer-events: none so page CSS never interferes and users can
 * watch the Agent glide to targets, click, type, scroll, and inspect live.
 *
 * Race-safety guarantees:
 * - Every cursor show increments `window.__piOverlayGen` and cancels any queued
 *   `requestAnimationFrame` + idle timer so a backgrounded tab resuming rAF can
 *   never resurrect an already-expired cursor pill.
 * - Trusted human input (`pointerdown`, `wheel`, `keydown`) immediately fades
 *   out and clears the overlay.
 */

const { scopedTypography } = require('../../theme.cjs');
const overlayTypography = scopedTypography('.pi-layer');

function overlayBootstrapSnippet() {
  return `
    const findPiRefDeep = (ref) => {
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

    const cleanupPiOverlayDom = (genExpected) => {
      if (typeof genExpected === 'number' && window.__piOverlayGen !== genExpected) return;
      if (window.__piOverlayRaf) {
        cancelAnimationFrame(window.__piOverlayRaf);
        window.__piOverlayRaf = 0;
      }
      if (window.__piOverlayIdleTimer) {
        clearTimeout(window.__piOverlayIdleTimer);
        window.__piOverlayIdleTimer = null;
      }
      if (window.__piOverlayRemoveTimer) {
        clearTimeout(window.__piOverlayRemoveTimer);
        window.__piOverlayRemoveTimer = null;
      }
      const host = document.getElementById('pi-agent-overlay-root');
      if (host) host.remove();
      document.querySelectorAll('[data-pi-highlight="1"]').forEach((el) => el.removeAttribute('data-pi-highlight'));
      const badge = document.getElementById('pi-browser-highlight-label');
      if (badge) badge.remove();
    };

    const dismissPiOverlaySoon = (immediate = false) => {
      window.__piOverlayGen = (window.__piOverlayGen || 0) + 1;
      const gen = window.__piOverlayGen;
      if (window.__piOverlayRaf) {
        cancelAnimationFrame(window.__piOverlayRaf);
        window.__piOverlayRaf = 0;
      }
      if (window.__piOverlayIdleTimer) {
        clearTimeout(window.__piOverlayIdleTimer);
        window.__piOverlayIdleTimer = null;
      }
      if (window.__piOverlayRemoveTimer) {
        clearTimeout(window.__piOverlayRemoveTimer);
        window.__piOverlayRemoveTimer = null;
      }
      const host = document.getElementById('pi-agent-overlay-root');
      const group = host?.shadowRoot?.getElementById('pi-cursor-group');
      if (immediate || !group) {
        cleanupPiOverlayDom(gen);
        return;
      }
      group.classList.remove('is-visible');
      window.__piOverlayRemoveTimer = setTimeout(() => {
        cleanupPiOverlayDom(gen);
      }, 240);
    };

    const ensureHumanDismissListeners = () => {
      if (window.__piOverlayHumanDismissBound) return;
      window.__piOverlayHumanDismissBound = true;
      const onHumanInput = (event) => {
        if (!event || !event.isTrusted) return;
        if (!document.getElementById('pi-agent-overlay-root')) return;
        dismissPiOverlaySoon(false);
      };
      window.addEventListener('pointerdown', onHumanInput, { capture: true, passive: true });
      window.addEventListener('wheel', onHumanInput, { capture: true, passive: true });
      window.addEventListener('keydown', onHumanInput, { capture: true, passive: true });
    };

    const ensurePiOverlay = () => {
      ensureHumanDismissListeners();
      let host = document.getElementById('pi-agent-overlay-root');
      if (host && host.shadowRoot) return host;
      host = document.createElement('div');
      host.id = 'pi-agent-overlay-root';
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(overlayTypography)} + \`
        :host { all: initial; }
        .pi-layer {
          position: fixed;
          inset: 0;
          pointer-events: none;
          overflow: hidden;
          font-family: var(--font);
        }
        .pi-cursor-group {
          position: fixed;
          top: 0;
          left: 0;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          transform: translate3d(var(--pi-x, 50vw), var(--pi-y, 45vh), 0) translateY(-50%);
          transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease;
          opacity: 0;
          will-change: transform, opacity;
        }
        .pi-cursor-group.is-visible { opacity: 1; }
        .pi-cursor-group.is-left { flex-direction: row-reverse; }
        .pi-pointer {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border-radius: 999px;
          background: rgba(24, 26, 31, 0.88);
          border: 1px solid rgba(255, 255, 255, 0.14);
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(96, 165, 250, 0.18);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          flex: none;
        }
        .pi-pointer svg {
          display: block;
          width: 13px;
          height: 13px;
          color: #93c5fd;
          filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35));
          animation: pi-pointer-breathe 1.8s ease-in-out infinite;
        }
        .pi-pill {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          height: 26px;
          max-width: min(320px, 68vw);
          padding: 0 11px;
          border-radius: 999px;
          background: rgba(24, 26, 31, 0.88);
          color: #eef2f6;
          font-size: var(--text-description);
          font-weight: var(--weight-medium);
          line-height: 1;
          letter-spacing: 0.01em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }
        .pi-ripple {
          position: fixed;
          top: 0;
          left: 0;
          width: 34px;
          height: 34px;
          margin: -17px 0 0 -17px;
          border-radius: 50%;
          border: 2px solid rgba(96, 165, 250, 0.85);
          background: rgba(96, 165, 250, 0.16);
          opacity: 0;
          pointer-events: none;
        }
        .pi-ripple.is-animating {
          animation: pi-ripple-burst 420ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        @keyframes pi-pointer-breathe {
          0%, 100% { opacity: 0.86; transform: scale(0.96); }
          50% { opacity: 1; transform: scale(1.04); }
        }
        @keyframes pi-ripple-burst {
          0% { transform: translate3d(var(--rx, 0px), var(--ry, 0px), 0) scale(0.35); opacity: 0.95; }
          100% { transform: translate3d(var(--rx, 0px), var(--ry, 0px), 0) scale(2.15); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .pi-cursor-group { transition: opacity 120ms ease; }
          .pi-pointer svg { animation: none; }
        }
      \`;
      const layer = document.createElement('div');
      layer.className = 'pi-layer';
      layer.dataset.platform = ${JSON.stringify(process.platform)};
      const group = document.createElement('div');
      group.className = 'pi-cursor-group';
      group.id = 'pi-cursor-group';
      const pointer = document.createElement('span');
      pointer.className = 'pi-pointer';
      pointer.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.2 2.4L12.6 7.3L8.3 8.6L6.6 12.8L3.2 2.4Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
      const pill = document.createElement('span');
      pill.className = 'pi-pill';
      pill.id = 'pi-cursor-pill';
      group.appendChild(pointer);
      group.appendChild(pill);
      const ripple = document.createElement('div');
      ripple.className = 'pi-ripple';
      ripple.id = 'pi-ripple';
      layer.appendChild(ripple);
      layer.appendChild(group);
      shadow.appendChild(style);
      shadow.appendChild(layer);
      (document.documentElement || document.body).appendChild(host);
      return host;
    };
  `;
}

/**
 * Move the virtual AI cursor & floating pill to a target ref or viewport point.
 * When `persistent` is true (active Agent browser session), the cursor stays
 * visible continuously across LLM thinking gaps until updated or cleared on
 * session end / human takeover.
 */
function buildAgentCursorScript({ ref = '', label = '', kind = 'move', x = null, y = null, idleMs = 2400, persistent = false } = {}) {
  return `(() => {
    ${overlayBootstrapSnippet()}
    window.__piOverlayGen = (window.__piOverlayGen || 0) + 1;
    const gen = window.__piOverlayGen;
    if (window.__piOverlayRaf) {
      cancelAnimationFrame(window.__piOverlayRaf);
      window.__piOverlayRaf = 0;
    }
    if (window.__piOverlayIdleTimer) {
      clearTimeout(window.__piOverlayIdleTimer);
      window.__piOverlayIdleTimer = null;
    }
    if (window.__piOverlayRemoveTimer) {
      clearTimeout(window.__piOverlayRemoveTimer);
      window.__piOverlayRemoveTimer = null;
    }

    const host = ensurePiOverlay();
    const shadow = host.shadowRoot;
    const group = shadow.getElementById('pi-cursor-group');
    const pill = shadow.getElementById('pi-cursor-pill');
    const ripple = shadow.getElementById('pi-ripple');
    const targetRef = ${JSON.stringify(String(ref || ''))};
    const labelText = ${JSON.stringify(String(label || '').slice(0, 120))};
    const kind = ${JSON.stringify(String(kind || 'move'))};
    const explicitX = ${Number.isFinite(x) ? Number(x) : 'null'};
    const explicitY = ${Number.isFinite(y) ? Number(y) : 'null'};
    const persistent = ${persistent ? 'true' : 'false'};
    const idleMs = ${Math.max(400, Number(idleMs) || 2400)};

    const vw = Math.max(120, window.innerWidth || 800);
    const vh = Math.max(120, window.innerHeight || 600);
    let tx = typeof explicitX === 'number' ? explicitX : (window.__piOverlayPos?.x ?? Math.round(vw * 0.5));
    let ty = typeof explicitY === 'number' ? explicitY : (window.__piOverlayPos?.y ?? Math.round(vh * 0.45));
    let elementMeta = null;

    if (targetRef) {
      const el = findPiRefDeep(targetRef);
      if (el) {
        try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch {}
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          tx = Math.round(rect.left + Math.min(rect.width / 2, Math.max(6, rect.width - 6)));
          ty = Math.round(rect.top + Math.min(rect.height / 2, Math.max(6, rect.height - 6)));
        }
        elementMeta = {
          tag: el.tagName.toLowerCase(),
          name: String(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 48),
        };
      }
    }

    tx = Math.max(16, Math.min(vw - 16, tx));
    ty = Math.max(16, Math.min(vh - 16, ty));
    window.__piOverlayPos = { x: tx, y: ty };

    host.style.visibility = 'visible';
    const flipLeft = tx > vw * 0.58;
    group.classList.toggle('is-left', flipLeft);
    group.style.setProperty('--pi-x', tx + 'px');
    group.style.setProperty('--pi-y', ty + 'px');

    const resolvedLabel = labelText || (elementMeta?.name ? elementMeta.name : targetRef);
    pill.textContent = resolvedLabel || 'AI 操作中…';
    pill.style.display = resolvedLabel ? 'inline-flex' : 'none';

    const expiresAt = persistent ? Number.MAX_SAFE_INTEGER : (Date.now() + idleMs);
    window.__piOverlayRaf = requestAnimationFrame(() => {
      window.__piOverlayRaf = 0;
      if (window.__piOverlayGen !== gen || Date.now() >= expiresAt) return;
      group.classList.add('is-visible');
    });

    if (kind === 'click' || kind === 'drag') {
      ripple.classList.remove('is-animating');
      ripple.style.setProperty('--rx', tx + 'px');
      ripple.style.setProperty('--ry', ty + 'px');
      void ripple.offsetWidth;
      ripple.classList.add('is-animating');
    }

    if (!persistent) {
      window.__piOverlayIdleTimer = setTimeout(() => {
        window.__piOverlayIdleTimer = null;
        if (window.__piOverlayGen !== gen) return;
        dismissPiOverlaySoon(false);
      }, idleMs);
    }

    return { ok: true, x: tx, y: ty, element: elementMeta };
  })()`;
}

/**
 * Gently update the already-visible live cursor pill while the Agent thinks
 * between browser tool calls so the user feels continuous live control.
 */
function buildAgentCursorStatusScript(label = 'AI 思考下一步…') {
  return `(() => {
    const host = document.getElementById('pi-agent-overlay-root');
    const shadow = host?.shadowRoot;
    const group = shadow?.getElementById('pi-cursor-group');
    const pill = shadow?.getElementById('pi-cursor-pill');
    if (!host || !group || !pill) return { ok: false };
    host.style.visibility = 'visible';
    group.classList.add('is-visible');
    pill.textContent = ${JSON.stringify(String(label || 'AI 思考下一步…').slice(0, 80))};
    pill.style.display = 'inline-flex';
    return { ok: true };
  })()`;
}

function buildOverlayVisibilityScript(visible) {
  return `(() => {
    const host = document.getElementById('pi-agent-overlay-root');
    if (host) host.style.visibility = ${visible ? "'visible'" : "'hidden'"};
    const badge = document.getElementById('pi-browser-highlight-label');
    if (badge) badge.style.visibility = ${visible ? "'visible'" : "'hidden'"};
    return { ok: true, visible: ${visible ? 'true' : 'false'} };
  })()`;
}

function buildClearOverlayScript() {
  return `(() => {
    window.__piOverlayGen = (window.__piOverlayGen || 0) + 1;
    if (window.__piOverlayRaf) {
      cancelAnimationFrame(window.__piOverlayRaf);
      window.__piOverlayRaf = 0;
    }
    if (window.__piOverlayIdleTimer) {
      clearTimeout(window.__piOverlayIdleTimer);
      window.__piOverlayIdleTimer = null;
    }
    if (window.__piOverlayRemoveTimer) {
      clearTimeout(window.__piOverlayRemoveTimer);
      window.__piOverlayRemoveTimer = null;
    }
    const host = document.getElementById('pi-agent-overlay-root');
    if (host) host.remove();
    try {
      document.querySelectorAll('[data-pi-highlight="1"]').forEach((el) => el.removeAttribute('data-pi-highlight'));
    } catch {}
    const badge = document.getElementById('pi-browser-highlight-label');
    if (badge) badge.remove();
    return { ok: true };
  })()`;
}

module.exports = {
  buildAgentCursorScript,
  buildAgentCursorStatusScript,
  buildClearOverlayScript,
  buildOverlayVisibilityScript,
};
