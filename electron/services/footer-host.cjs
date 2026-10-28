// 终端组件的最小宿主：内容、命中区域和浮层动作全部由扩展决定，
// 桌面端只负责把字符单元和鼠标坐标送过去，再把扩展画出的行显示出来。
// 这样 App 不需要认识额度、上下文、性能等任何扩展概念。
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 一个 grapheme 在等宽终端里占 1 或 2 列（CJK、emoji 和全角符号为 2）。
 * 规则与 Pi 扩展使用的 visibleWidth 对齐，否则浮层边框会错位。 */
function cellWidth(text) {
  if (/^\p{Mark}+$/u.test(text)) return 0;
  if (/[\uFE0F\u20E3]|\p{Extended_Pictographic}/u.test(text)) return 2;
  const cp = text.codePointAt(0) || 0;
  if (cp >= 0x1f000 && cp <= 0x1ffff) return 2;
  if (cp >= 0x2600 && cp <= 0x27bf) return 2;
  if (cp >= 0x2300 && cp <= 0x23ff) return 2;
  const wide = cp >= 0x1100 && (
    cp <= 0x115f
    || cp >= 0x2e80 && cp <= 0xa4cf
    || cp >= 0xac00 && cp <= 0xd7a3
    || cp >= 0xf900 && cp <= 0xfaff
    || cp >= 0xfe10 && cp <= 0xfe6f
    || cp >= 0xff00 && cp <= 0xff60
    || cp >= 0xffe0 && cp <= 0xffe6
    || cp >= 0x20000
  );
  return wide ? 2 : 1;
}

/** 把扩展返回的一行文本拆成可逐列定位的单元，保留原始字符与语义色。
 * 扩展用 theme.fg / theme.bold 写出的 SGR 序列在这里转成 tone，
 * 渲染层再映射到应用主题；没有样式的文本保持默认。 */
const ANSI = /\x1b\[([0-9;]*)m|\x1b\[[0-?]*[ -/]*[@-~]/g;
const SGR_TONES = {
  30: 'muted', 31: 'error', 32: 'success', 33: 'warning', 34: 'link', 35: 'accent', 36: 'info', 37: 'text',
  90: 'muted', 91: 'error', 92: 'success', 93: 'warning', 94: 'link', 95: 'accent', 96: 'info', 97: 'text',
};
function cells(line) {
  const text = String(line ?? '');
  const result = [];
  let tone = '';
  let bold = false;
  let last = 0;
  const push = (chunk) => {
    for (const { segment } of segmenter.segment(chunk)) {
      result.push({
        text: segment,
        width: cellWidth(segment),
        ...(tone ? { tone } : {}),
        ...(bold ? { bold: true } : {}),
      });
    }
  };
  const apply = (code) => {
    if (code === 0) { tone = ''; bold = false; }
    else if (code === 1) bold = true;
    else if (code === 22) { bold = false; if (tone === 'faint') tone = ''; }
    else if (code === 2) tone = 'faint';
    else if (code === 39) tone = '';
    else if (SGR_TONES[code]) tone = SGR_TONES[code];
  };
  for (const match of text.matchAll(ANSI)) {
    push(text.slice(last, match.index));
    if (match[1] !== undefined) for (const code of match[1].split(';').filter(Boolean).map(Number)) apply(code);
    last = match.index + match[0].length;
  }
  push(text.slice(last));
  return result;
}

const RULE = /^[─━═]{3,}$/u;
const CLOSE_GLYPH = /([ｘx✕×X])\s*$/u;
const rowText = (row) => row.map((cell) => cell.text).join('');

/** 扩展的面板经常用终端边框画卡片；识别出来才能换成桌面端卡片样式。 */
function hasFrame(grid) {
  if (grid.length < 4) return false;
  const top = rowText(grid[0]).trim();
  const bottom = rowText(grid[grid.length - 1]).trim();
  if (!top.startsWith('╭') || !top.endsWith('╮')) return false;
  if (!bottom.startsWith('╰') || !bottom.endsWith('╯')) return false;
  return grid.slice(1, -1).every((row) => {
    const first = row.findIndex((cell) => cell.text === '│');
    const last = row.findLastIndex((cell) => cell.text === '│');
    return first >= 0 && last > first;
  });
}

/** 把 plain 文本索引换算成它前面的单元格宽度；用于还原扩展的关闭按钮列。 */
function widthBefore(row, index) {
  let width = 0;
  let consumed = 0;
  for (const cell of row) {
    if (consumed >= index) break;
    consumed += cell.text.length;
    width += cell.width;
  }
  return width;
}

/**
 * 把扩展面板从「终端卡片」整理成「内容 + 行类型」：
 *  - 去掉外框和左右两条边框；
 *  - 把标题行提出来，交给渲染层画成原生标题；
 *  - 把 ── 分隔线标成 rule，避免在桌面端出现 ASCII 横线；
 *  - 记录被裁掉的行 / 列偏移，点击时加回去，扩展的命中区域不会错位。
 * 在细胞级别处理，扩展写的主题色不会在裁剪时丢失。
 */
function normalizePanel(rawLines) {
  const grid = rawLines.map(cells);
  const framed = hasFrame(grid);
  let body = framed
    ? grid.slice(1, -1).map((row) => {
      const first = row.findIndex((cell) => cell.text === '│');
      const last = row.findLastIndex((cell) => cell.text === '│');
      return row.slice(first + 1, last);
    })
    : grid.map((row) => [...row]);
  let offsetRow = framed ? 1 : 0;
  const offsetCol = framed ? 1 : 0;
  let title = '';
  let close = null;

  // 扩展的卡片常在外框和标题之间留一行空白；先裁掉，标题才会落在第一行。
  const trimLeading = () => {
    let lead = 0;
    while (lead < body.length && !rowText(body[lead]).trim()) lead += 1;
    body = body.slice(lead);
    offsetRow += lead;
  };
  trimLeading();

  if (framed && body.length > 1) {
    const first = body[0];
    const text = rowText(first);
    const match = text.match(CLOSE_GLYPH);
    // 只有「标题 + 大段留白 + 关闭符号 + 下一行是分隔线」才当成标题栏，
    // 避免把普通内容行误识别成标题。
    if (match && /[ \t]{2,}$/u.test(text.slice(0, match.index)) && RULE.test(rowText(body[1]).trim())) {
      title = text.slice(0, match.index).trim();
      // 扩展的命中坐标以整个面板宽度为坐标系，这里补回左侧边框。
      close = { row: offsetRow, col: offsetCol + widthBefore(first, match.index) };
      body = body.slice(2);
      offsetRow += 2;
      trimLeading();
    }
  }

  let end = body.length;
  while (end > 0 && !rowText(body[end - 1]).trim()) end -= 1;
  body = body.slice(0, end);

  const contentWidth = body.reduce(
    (widest, row) => Math.max(widest, row.reduce((sum, cell) => sum + cell.width, 0)),
    0,
  );
  return {
    lines: body,
    rowTypes: body.map((row) => RULE.test(rowText(row).trim()) ? 'rule' : 'text'),
    title,
    close,
    offset: { row: offsetRow, col: offsetCol },
    contentWidth,
  };
}

/** 一套最小 pi-tui 主题：把语义色编码成 SGR，渲染层再映射回应用主题。 */
function createTheme() {
  const identity = (text) => text;
  const FOREGROUND = {
    // 37 只是「正文」的语义标记，真正的颜色由 CSS token 决定；
    // 39 保留给 reset，避免把后续未着色文本也当成正文。
    text: 37, muted: 90, faint: 2, dim: 2, accent: 35, brand: 35,
    error: 31, danger: 31, warning: 33, success: 32, info: 36, link: 34,
  };
  return {
    fg: (color, text) => `\x1b[${FOREGROUND[color] ?? 39}m${text}\x1b[39m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    dim: (text) => `\x1b[2m${text}\x1b[22m`,
    italic: identity,
    underline: identity,
    strikethrough: identity,
    // 背景 / 边框由桌面端卡片负责，不把终端色块引进界面。
    style: identity,
    appearance: 'light',
  };
}

function createFooterHost(publish) {
  let footer;
  let overlay;
  let rendering = false;
  const listeners = new Set();
  const terminal = { columns: 120, rows: 36 };
  // 扩展只关心语义颜色：这里把颜色名编成 SGR，cells 再解析成 tone，
  // 渲染层最后映射到应用主题，ANSI 不会出现在界面上。
  const theme = createTheme();
  let snapshot = { lines: [], overlay: null, interactive: false };

  /** 读取扩展当前的 footer 与浮层，生成给渲染层的快照。 */
  function render() {
    if (rendering) return snapshot;
    rendering = true;
    try {
      const lines = footer?.render(terminal.columns) || [];
      const active = overlay;
      const visible = active && (!active.options.visible || active.options.visible(terminal.columns, terminal.rows));
      const panelLines = visible ? active.component.render(active.options.width) || [] : [];
      const panel = normalizePanel(panelLines);
      snapshot = {
        lines: lines.map(cells),
        interactive: typeof footer?.handleMouse === 'function',
        overlay: panel.lines.length > 0 || panel.title ? {
          ...panel,
          col: Number(active.options.col) || 0,
          row: Number(active.options.row) || 0,
          width: Number(active.options.width) || terminal.columns,
        } : null,
      };
    } catch {
      // 扩展渲染失败时保留一个可恢复的空快照，不能让一次异常拖垮整个会话。
      snapshot = { lines: [], overlay: null, interactive: false };
    } finally {
      rendering = false;
    }
    publish({ text: snapshot.lines.map((line) => line.map((cell) => cell.text).join('')).join('\n'), view: snapshot });
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
    showOverlay(component, options = {}) {
      const entry = { component, options };
      overlay = entry;
      return {
        hide() { if (overlay === entry) overlay = undefined; },
        getBounds() {
          return { row: options.row, col: options.col, width: options.width, height: options.maxHeight };
        },
      };
    },
  };

  /**
   * 渲染层发来的输入：resize 同步可用尺寸，click / wheel 带单元格坐标，
   * close / key 交给扩展自己注册的输入监听器处理。
   */
  function action(input = {}) {
    if (input.type === 'resize') {
      terminal.columns = Math.max(22, Math.min(400, Math.floor(input.columns) || 120));
      terminal.rows = Math.max(12, Math.min(100, Math.floor(input.rows) || 36));
      theme.appearance = input.appearance === 'dark' ? 'dark' : 'light';
      footer?.invalidate?.();
    } else if (input.type === 'close' || input.type === 'key') {
      const key = input.type === 'close' ? '\x1b' : String(input.key || '');
      let consumed = false;
      for (const listener of [...listeners]) {
        if (listener(key)?.consume) { consumed = true; break; }
      }
      if (!consumed) overlay?.component.handleInput?.(key);
    } else if (input.type === 'click' || input.type === 'wheel') {
      const target = input.target === 'overlay' ? overlay?.component : footer;
      const x = Math.max(0, Math.floor(input.x) || 0);
      const y = Math.max(0, Math.floor(input.y) || 0);
      const overlayRow = Number(overlay?.options.row) || 0;
      const overlayCol = Number(overlay?.options.col) || 0;
      target?.handleMouse?.({
        type: input.type,
        button: 'left',
        x,
        y,
        screenX: input.target === 'overlay' ? x + overlayCol : x,
        screenY: input.target === 'overlay' ? y + overlayRow : terminal.rows - 1,
        wheelDelta: Number(input.delta) || 0,
        clickCount: 1,
      });
    }
    return render();
  }

  return {
    tui,
    theme,
    render,
    action,
    get view() { return snapshot; },
    get active() { return Boolean(footer); },
    set(factory, data) {
      try { footer?.dispose?.(); } catch { /* 旧组件可能已经失效 */ }
      footer = undefined;
      overlay = undefined;
      listeners.clear();
      if (typeof factory === 'function') footer = factory(tui, theme, data);
      render();
    },
  };
}

module.exports = { createFooterHost, createTheme, cells, cellWidth, normalizePanel };
