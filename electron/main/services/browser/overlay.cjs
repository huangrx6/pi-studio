/**
 * In-page live AI cursor, floating action pill, and click ripple overlay.
 *
 * Runs inside guest pages via executeJavaScript using an isolated Shadow DOM
 * layer with pointer-events: none so page CSS never interferes and users can
 * watch the Agent glide to targets, click, type, scroll, and inspect live.
 */

function overlayBootstrapSnippet() {
  return `
    const ensurePiOverlay = () => {
      let host = document.getElementById('pi-agent-overlay-root');
      if (host && host.shadowRoot) return host;
      host = document.createElement('div');
      host.id = 'pi-agent-overlay-root';
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = \`
        :host { all: initial; }
        .pi-layer {
          position: fixed;
          inset: 0;
          pointer-events: none;
          overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", sans-serif;
        }
        .pi-cursor-group {
          position: fixed;
          top: 0;
          left: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          transform: translate3d(var(--pi-x, 50vw), var(--pi-y, 45vh), 0);
          transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease;
          opacity: 0;
          will-change: transform, opacity;
        }
        .pi-cursor-group.is-visible { opacity: 1; }
        .pi-cursor-group.is-left { flex-direction: row-reverse; }
        .pi-dot-grid {
          position: relative;
          display: grid;
          grid-template-columns: repeat(2, 5px);
          grid-template-rows: repeat(2, 5px);
          gap: 3px;
          padding: 4px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.92);
          box-shadow: 0 2px 10px rgba(15, 23, 42, 0.22), 0 0 0 1px rgba(15, 23, 42, 0.08);
          transform: translate(-50%, -50%);
          flex: none;
        }
        .pi-dot-grid i {
          display: block;
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #111827;
          animation: pi-dot-pulse 1.1s ease-in-out infinite;
        }
        .pi-dot-grid i:nth-child(2) { animation-delay: 0.14s; background: #3b82f6; }
        .pi-dot-grid i:nth-child(3) { animation-delay: 0.28s; background: #3b82f6; }
        .pi-dot-grid i:nth-child(4) { animation-delay: 0.42s; }
        .pi-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          max-width: min(320px, 68vw);
          padding: 6px 12px;
          border-radius: 999px;
          background: rgba(15, 17, 23, 0.88);
          color: #f8fafc;
          font-size: 12px;
          font-weight: 500;
          line-height: 1.3;
          letter-spacing: 0.01em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24), 0 0 0 1px rgba(255, 255, 255, 0.12);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          transform: translateY(-50%);
        }
        .pi-ripple {
          position: fixed;
          top: 0;
          left: 0;
          width: 34px;
          height: 34px;
          margin: -17px 0 0 -17px;
          border-radius: 50%;
          border: 2px solid rgba(59, 130, 246, 0.85);
          background: rgba(59, 130, 246, 0.18);
          opacity: 0;
          pointer-events: none;
        }
        .pi-ripple.is-animating {
          animation: pi-ripple-burst 420ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        @keyframes pi-dot-pulse {
          0%, 100% { transform: scale(0.78); opacity: 0.55; }
          50% { transform: scale(1.12); opacity: 1; }
        }
        @keyframes pi-ripple-burst {
          0% { transform: translate3d(var(--rx, 0px), var(--ry, 0px), 0) scale(0.35); opacity: 0.95; }
          100% { transform: translate3d(var(--rx, 0px), var(--ry, 0px), 0) scale(2.15); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .pi-cursor-group { transition: opacity 120ms ease; }
          .pi-dot-grid i { animation: none; }
        }
      \`;
      const layer = document.createElement('div');
      layer.className = 'pi-layer';
      const group = document.createElement('div');
      group.className = 'pi-cursor-group';
      group.id = 'pi-cursor-group';
      const dots = document.createElement('span');
      dots.className = 'pi-dot-grid';
      dots.innerHTML = '<i></i><i></i><i></i><i></i>';
      const pill = document.createElement('span');
      pill.className = 'pi-pill';
      pill.id = 'pi-cursor-pill';
      group.appendChild(dots);
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
 */
function buildAgentCursorScript({ ref = '', label = '', kind = 'move', x = null, y = null, idleMs = 2800 } = {}) {
  return `(() => {
    ${overlayBootstrapSnippet()}
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
    const idleMs = ${Math.max(400, Number(idleMs) || 2800)};

    const vw = Math.max(120, window.innerWidth || 800);
    const vh = Math.max(120, window.innerHeight || 600);
    let tx = typeof explicitX === 'number' ? explicitX : (window.__piOverlayPos?.x ?? Math.round(vw * 0.5));
    let ty = typeof explicitY === 'number' ? explicitY : (window.__piOverlayPos?.y ?? Math.round(vh * 0.45));
    let elementMeta = null;

    if (targetRef) {
      const el = document.querySelector('[data-pi-ref=' + JSON.stringify(targetRef) + ']');
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

    requestAnimationFrame(() => {
      group.classList.add('is-visible');
    });

    if (kind === 'click' || kind === 'drag') {
      ripple.classList.remove('is-animating');
      ripple.style.setProperty('--rx', tx + 'px');
      ripple.style.setProperty('--ry', ty + 'px');
      void ripple.offsetWidth;
      ripple.classList.add('is-animating');
    }

    if (window.__piOverlayIdleTimer) clearTimeout(window.__piOverlayIdleTimer);
    window.__piOverlayIdleTimer = setTimeout(() => {
      group.classList.remove('is-visible');
    }, idleMs);

    return { ok: true, x: tx, y: ty, element: elementMeta };
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
    if (window.__piOverlayIdleTimer) {
      clearTimeout(window.__piOverlayIdleTimer);
      window.__piOverlayIdleTimer = null;
    }
    const host = document.getElementById('pi-agent-overlay-root');
    if (host) host.remove();
    return { ok: true };
  })()`;
}

module.exports = {
  buildAgentCursorScript,
  buildClearOverlayScript,
  buildOverlayVisibilityScript,
};
