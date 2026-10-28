/**
 * 通用扩展 surface 宿主。
 *
 * 一个 pi-tui Component 只要实现了 render(width)（可选 handleInput / handleMouse），
 * 就能被这里渲染成「字符单元 + 语义色」的快照，供桌面端任意槽位显示：
 *   - setWidget 的组件
 *   - custom() 的浮层 / 面板
 *   - 未来 setHeader / setEditorComponent
 *
 * 终端尺寸、鼠标坐标、键盘序列都在这里按 TUI 约定转交给组件，
 * 渲染层因此不需要认识任何具体扩展。
 */

const { cells, createTheme } = require('./footer-host.cjs');

/** 桌面端按键 → 终端输入序列。 */
const KEY_SEQUENCES = {
  Enter: '\r',
  Escape: '\x1b',
  Backspace: '\x7f',
  Tab: '\t',
  Delete: '\x1b[3~',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  ' ': ' ',
};

function inputFor(input) {
  if (typeof input.sequence === 'string') return input.sequence;
  const key = String(input.key || '');
  if (input.ctrl && key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  }
  if (Object.prototype.hasOwnProperty.call(KEY_SEQUENCES, key)) return KEY_SEQUENCES[key];
  return key;
}

function createSurfaceHost(publish = () => {}) {
  let component;
  let disposed = false;
  let rendering = false;
  const listeners = new Set();
  const terminal = { columns: 100, rows: 36 };
  const theme = createTheme();
  let snapshot = { lines: [], raw: [], interactive: false };

  function render() {
    if (disposed || rendering) return snapshot;
    rendering = true;
    try {
      const raw = component?.render(terminal.columns) || [];
      snapshot = {
        lines: raw.map(cells),
        raw,
        interactive: typeof component?.handleMouse === 'function',
      };
    } catch {
      snapshot = { lines: [], raw: [], interactive: false };
    } finally {
      rendering = false;
    }
    try { publish(snapshot); } catch { /* 渲染层异常不能拖垮扩展 */ }
    return snapshot;
  }

  const tui = {
    mode: 'fullscreen',
    terminal,
    requestRender: render,
    addInputListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // 嵌套浮层在桌面端暂不单独开窗；保留句柄，避免扩展调用时报错。
    showOverlay() {
      return { hide() {}, getBounds() { return { row: 0, col: 0, width: terminal.columns, height: terminal.rows }; } };
    },
  };

  /** 渲染层输入：resize 同步尺寸，click/wheel/key 转成组件能理解的事件。 */
  function action(input = {}) {
    if (disposed) return snapshot;
    if (input.type === 'resize') {
      terminal.columns = Math.max(20, Math.min(400, Math.floor(input.columns) || 100));
      terminal.rows = Math.max(10, Math.min(100, Math.floor(input.rows) || 36));
      theme.appearance = input.appearance === 'dark' ? 'dark' : 'light';
      component?.invalidate?.();
      return render();
    }
    if (input.type === 'key' || input.type === 'close') {
      const data = input.type === 'close' ? '\x1b' : inputFor(input);
      let consumed = false;
      for (const listener of [...listeners]) {
        if (listener(data)?.consume) { consumed = true; break; }
      }
      if (!consumed) component?.handleInput?.(data);
      return render();
    }
    if (input.type === 'click' || input.type === 'wheel') {
      const x = Math.max(0, Math.floor(input.x) || 0);
      const y = Math.max(0, Math.floor(input.y) || 0);
      component?.handleMouse?.({
        type: input.type,
        button: 'left',
        x,
        y,
        screenX: x,
        screenY: y,
        wheelDelta: Number(input.delta) || 0,
        clickCount: 1,
      });
      return render();
    }
    return render();
  }

  /** 设置新组件；传 undefined 表示清空。 */
  function set(factory) {
    if (disposed) return;
    try { component?.dispose?.(); } catch { /* 旧组件可能已经失效 */ }
    component = undefined;
    listeners.clear();
    if (typeof factory === 'function') {
      try { component = factory(tui, theme); } catch { component = undefined; }
    }
    render();
  }

  function dispose() {
    disposed = true;
    try { component?.dispose?.(); } catch { /* 忽略 */ }
    component = undefined;
    listeners.clear();
  }

  return {
    tui,
    theme,
    action,
    set,
    dispose,
    render,
    get view() { return snapshot; },
    get active() { return Boolean(component); },
  };
}

module.exports = { createSurfaceHost };
