import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronUp,
  Eraser,
  MoreHorizontal,
  Plus,
  RotateCw,
  Search,
  Terminal as TerminalIcon,
  TriangleAlert,
  X,
} from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalEvent, TerminalSessionStatus } from '../../types/runtime-panel-types';
import { errorText } from '../../shared/error-text';
import { ActionMenu, type MenuAction } from '../../shared/ActionMenu';
import { restoreTerminalReplay } from './terminal-replay';
import { terminalTheme as themedTerminal, isTerminalTheme } from './terminal-themes';
import { CommandTracker, adjacentCommand, commandFailed, lastFailedCommand, parseOsc133, type CommandMark } from './terminal-commands';
import type { TerminalCursorStyle } from '../../shared/preferences';
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  needsPasteConfirm,
  parseTerminalLink,
  shellQuotePath,
  stepTerminalFontSize,
  terminalKeyIntent,
  terminalTabTitle,
  type TerminalLinkTarget,
} from './terminal-actions';
import './terminal-panel.css';

const MAX_PENDING_EVENTS = 256;
const MAX_PENDING_CHARS = 1_000_000;

function terminalFontFamily() {
  // Symbols precede the generic monospace fallback, which otherwise swallows
  // private-use Nerd Font characters as missing-glyph boxes on macOS.
  return `"Studio Terminal Symbols", ${token('--mono')}`;
}

function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function terminalTheme(): ITheme {
  return {
    background: token('--surface'),
    foreground: token('--text'),
    cursor: token('--accent'),
    cursorAccent: token('--surface'),
    selectionBackground: token('--surface-active'),
    black: token('--terminal-ansi-black'),
    red: token('--terminal-ansi-red'),
    green: token('--terminal-ansi-green'),
    yellow: token('--terminal-ansi-yellow'),
    blue: token('--terminal-ansi-blue'),
    magenta: token('--terminal-ansi-magenta'),
    cyan: token('--terminal-ansi-cyan'),
    white: token('--terminal-ansi-white'),
    brightBlack: token('--terminal-ansi-bright-black'),
    brightRed: token('--terminal-ansi-bright-red'),
    brightGreen: token('--terminal-ansi-bright-green'),
    brightYellow: token('--terminal-ansi-bright-yellow'),
    brightBlue: token('--terminal-ansi-bright-blue'),
    brightMagenta: token('--terminal-ansi-bright-magenta'),
    brightCyan: token('--terminal-ansi-bright-cyan'),
    brightWhite: token('--terminal-ansi-bright-white'),
  };
}

/**
 * 把输出里的 `path:line` 变成可点链接。
 *
 * URL 由 WebLinksAddon 负责；这个 provider 只认文件路径，点在右侧面板打开。
 * 坐标是 1-based 的列号，和 `buffer.getLine` 的 0-based 行号差一。
 */
function registerFileLinks(term: Terminal, open: (target: TerminalLinkTarget) => void) {
  return term.registerLinkProvider({
    provideLinks(row, callback) {
      const line = term.buffer.active.getLine(row - 1);
      const text = line?.translateToString(true) ?? '';
      // 含 URL 的行整行交给 WebLinksAddon，避免把 https://host/a 的路径段
      // 也注册成文件链接。
      if (!text || /https?:\/\//iu.test(text)) { callback(undefined); return; }
      const links = [...text.matchAll(/[A-Za-z0-9_.~/@-]*\/[A-Za-z0-9_.~/@-]+(?::\d+(?::\d+)?)?/gu)]
        .map((match) => {
          const target = parseTerminalLink(match[0]);
          if (!target || target.kind !== 'file') return null;
          const start = (match.index ?? 0) + 1;
          return {
            text: match[0],
            range: { start: { x: start, y: row }, end: { x: start + match[0].length - 1, y: row } },
            activate: () => open(target),
          };
        })
        .filter((link): link is NonNullable<typeof link> => link !== null);
      callback(links.length > 0 ? links : undefined);
    },
  });
}

/** 终端外观：主题、字体与光标。全部来自偏好，改动即时生效。 */
export type TerminalAppearance = {
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  themeId: string;
};

function fontFamilyOf(custom: string) {
  // Symbols 必须排在最前面，否则 Nerd Font 私有区字符会被通用等宽字体吞成方块。
  return custom
    ? `"Studio Terminal Symbols", "${custom.replaceAll('"', '')}", ${token('--mono')}`
    : terminalFontFamily();
}

export function TerminalPanel({
  id,
  cwd,
  appearance,
  shellIntegration,
  onFontSizeChange,
  onNewTerminal,
  onOpenFile,
  onOpenUrl,
  onTitle,
}: {
  id: string;
  cwd: string;
  appearance: TerminalAppearance;
  shellIntegration: boolean;
  onFontSizeChange: (size: number) => void;
  onNewTerminal: () => void;
  onOpenFile?: (path: string) => void;
  onOpenUrl?: (url: string) => void;
  onTitle?: (title: string) => void;
}) {
  const fontSize = appearance.fontSize;
  const hostRef = useRef<HTMLDivElement>(null);
  const focusTerminalRef = useRef<(() => void) | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const commandsRef = useRef(new CommandTracker());
  const [connecting, setConnecting] = useState(true);
  const [status, setStatus] = useState<TerminalSessionStatus>('running');
  const [exitCode, setExitCode] = useState<number | undefined>();
  const [shell, setShell] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState(cwd);
  const [error, setError] = useState<string | null>(null);
  const [fontWarning, setFontWarning] = useState(false);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [retryRevision, setRetryRevision] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [searchHits, setSearchHits] = useState({ index: -1, count: 0 });
  const [failedCommands, setFailedCommands] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  // 链接与偏好会随组件重建，用 ref 让 xterm 的回调始终读到最新实现。
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onOpenUrlRef = useRef(onOpenUrl);
  onOpenUrlRef.current = onOpenUrl;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  // 只由外观 effect 更新：首次挂载不算「变化」，避免白白重绘一次。
  const appliedAppearanceRef = useRef(appearance);

  const openLink = useCallback((target: TerminalLinkTarget) => {
    if (target.kind === 'url') { onOpenUrlRef.current?.(target.url); return; }
    onOpenFileRef.current?.(target.line ? `${target.path}:${target.line}` : target.path);
  }, []);

  const writeToPty = useCallback((data: string) => {
    void window.piApi.terminalWrite(id, data).catch((cause) => setError(errorText(cause)));
  }, [id]);

  /** 读剪贴板再交给 PTY；多行粘贴先停在确认条上。 */
  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      if (needsPasteConfirm(text)) setPendingPaste(text);
      else writeToPty(text);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [writeToPty]);

  /** 把缓冲区里的全部输出（含回看）复制成纯文本。 */
  const copyAllOutput = useCallback(async () => {
    const serialized = serializeRef.current?.serialize({ scrollback: 100_000 }) ?? '';
    if (!serialized.trim()) return;
    try { await navigator.clipboard.writeText(serialized); } catch { /* 剪贴板不可用时静默 */ }
  }, []);

  const copySelection = useCallback(async () => {
    const selection = terminalRef.current?.getSelection() ?? '';
    if (!selection) return false;
    try {
      await navigator.clipboard.writeText(selection);
      return true;
    } catch {
      return false;
    }
  }, []);

  const clearScreen = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.clear();
    term.focus();
  }, []);

  const scrollToBottom = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.scrollToBottom();
    term.focus();
  }, []);

  /** 在命令之间跳转：以视口顶部为参照，和 shell 集成的标记对齐。 */
  const jumpCommand = useCallback((direction: -1 | 1) => {
    const term = terminalRef.current;
    if (!term) return;
    const currentRow = term.buffer.active.viewportY;
    const target = adjacentCommand(commandsRef.current.list(), currentRow, direction);
    if (!target) return;
    term.scrollToLine(target.row);
    term.focus();
  }, []);

  /** 跳到最近一条失败命令；没有失败就什么都不做。 */
  const jumpToFailure = useCallback(() => {
    const term = terminalRef.current;
    const target = lastFailedCommand(commandsRef.current.list());
    if (!term || !target) return;
    term.scrollToLine(target.row);
    term.focus();
  }, []);

  const zoom = useCallback((direction: 1 | -1) => {
    const next = stepTerminalFontSize(fontSize, direction);
    if (next !== fontSize) onFontSizeChange(next);
  }, [fontSize, onFontSizeChange]);

  const openSearch = useCallback(() => {
    const selection = terminalRef.current?.getSelection() ?? '';
    if (selection && !selection.includes('\n')) setSearchQuery(selection);
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.select());
  }, []);

  const menuActions: MenuAction[] = (() => [
    { label: '复制', disabled: !(terminalRef.current?.hasSelection() ?? false), run: () => { void copySelection(); } },
    { label: '粘贴', run: () => { void pasteFromClipboard(); } },
    { label: '全选', run: () => { terminalRef.current?.selectAll(); } },
    { label: '复制全部输出', run: () => { void copyAllOutput(); } },
    { label: '清屏', run: clearScreen },
    { label: '搜索', run: openSearch },
    { label: '跳到最新', run: scrollToBottom },
    { label: '上一条命令', run: () => jumpCommand(-1) },
    { label: '下一条命令', run: () => jumpCommand(1) },
    { label: fontSize >= MAX_TERMINAL_FONT_SIZE ? '放大（已最大）' : '放大字号', disabled: fontSize >= MAX_TERMINAL_FONT_SIZE, run: () => zoom(1) },
    { label: fontSize <= MIN_TERMINAL_FONT_SIZE ? '缩小（已最小）' : '缩小字号', disabled: fontSize <= MIN_TERMINAL_FONT_SIZE, run: () => zoom(-1) },
    { label: '重新连接', run: () => setRetryRevision((value) => value + 1) },
  ])();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let ready = false;
    let failed = false;
    let restoring = false;
    let fitPending = false;
    let lastSize = '';
    let appearanceDirty = false;
    let mayFocus = true;
    setConnecting(true);
    setError(null);
    setExitCode(undefined);
    setShell('');
    setWorkingDirectory(cwd);
    setFontWarning(false);
    setHistoryTruncated(false);
    let restoredSequence = 0;
    let frame = 0;
    const pending: TerminalEvent[] = [];
    let pendingChars = 0;
    let droppedSequence = 0;
    const custom = themedTerminal(appearance.themeId);
    const term = new Terminal({
      // Unicode11 的宽度表属于 xterm 的 proposed API，终端需要它来对齐
      // emoji 与中日韩宽字符；其余 proposed 能力这里没有使用。
      allowProposedApi: true,
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      cursorStyle: appearance.cursorStyle,
      // macOS 上默认按 ⌥ 会输入特殊字符，shell 的 ⌥←/⌥→ 就用不了。
      macOptionIsMeta: true,
      // 暗色 ANSI 颜色直接压在背景上会糊，交给 xterm 抬到可读对比度。
      minimumContrastRatio: 4.5,
      fastScrollSensitivity: 8,
      smoothScrollDuration: 80,
      fontFamily: fontFamilyOf(appearance.fontFamily),
      fontSize,
      lineHeight: appearance.lineHeight,
      scrollback: 8_000,
      theme: custom ?? terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    const searchResults = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setSearchHits({ index: resultIndex, count: resultCount });
    });
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon((event, uri) => {
      event.preventDefault();
      openLink({ kind: 'url', url: uri });
    }));
    // OSC 8：`ls --hyperlink` 与不少 CLI 用超链接包住文件名，明文里看不到 URL。
    term.options.linkHandler = {
      activate: (event, text) => {
        event.preventDefault();
        const target = parseTerminalLink(text);
        if (target) openLink(target);
      },
    };
    // shell 集成：解析 OSC 133，记录每条命令的行号与退出码。
    const tracker = new CommandTracker();
    commandsRef.current = tracker;
    const commandMarks: { mark: CommandMark; decoration?: { dispose: () => void } }[] = [];
    const oscSubscription = term.parser.registerOscHandler(133, (payload) => {
      const event = parseOsc133(payload);
      if (!event) return false;
      if (event.type === 'command-start') tracker.start(term.buffer.active.baseY + term.buffer.active.cursorY);
      if (event.type === 'command-end') {
        const mark = tracker.end(event.exitCode);
        if (mark) {
          setFailedCommands(tracker.failureCount());
          // 失败命令在滚动条上留一个红点，长输出里也能定位。
          if (commandFailed(mark)) {
            const decoration = term.registerDecoration({
              marker: term.registerMarker(mark.row - (term.buffer.active.baseY + term.buffer.active.cursorY)),
              width: 1,
              overviewRulerOptions: { color: token('--error'), position: 'full' },
            });
            if (decoration) commandMarks.push({ mark, decoration });
          }
        }
      }
      return true;
    });
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    serializeRef.current = serialize;
    const titleSubscription = term.onTitleChange((title) => {
      onTitleRef.current?.(terminalTabTitle(title, ''));
    });
    const fileLinks = registerFileLinks(term, openLink);
    term.open(host);
    // WebGL 让几千行输出不再掉帧；拿不到上下文或显卡驱动出问题时退回 DOM。
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try { webgl.dispose(); } catch { /* 已经释放 */ }
      });
      term.loadAddon(webgl);
    } catch {
      // 没有 GPU 就继续用 DOM 渲染器
    }
    terminalRef.current = term;
    searchRef.current = search;
    fitRef.current = () => {
      try { fit.fit(); } catch { /* 面板隐藏时没有几何信息 */ }
    };
    focusTerminalRef.current = () => term.focus();

    const fitTerminal = () => {
      frame = 0;
      if (disposed || restoring || document.hidden || !host.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) return;
      let fitSequence = restoredSequence;
      const applyFit = () => {
        if (disposed || failed || restoring || document.hidden || !host.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) { fitPending = false; return; }
        // Output received after the first barrier is queued behind it. Wait for
        // that output too instead of parsing it after this geometry change.
        if (ready && fitSequence !== restoredSequence) {
          fitSequence = restoredSequence;
          try { term.write('', applyFit); } catch { fitPending = false; }
          return;
        }
        fitPending = false;
        try {
          fit.fit();
          const size = `${term.cols}:${term.rows}`;
          if (ready && size !== lastSize) {
            lastSize = size;
            void window.piApi.terminalResize(id, term.cols, term.rows).catch(() => {});
          }
        } catch {
          // A hidden tab has no measurable geometry; the observer retries on show.
        }
      };
      // xterm parses writes asynchronously. Finish already queued output at its
      // old geometry before a user resize or the post-attachment fit changes it.
      if (ready) {
        fitPending = true;
        try { term.write('', applyFit); } catch { fitPending = false; }
      } else applyFit();
    };
    const scheduleFit = () => {
      if (disposed || document.hidden || frame || fitPending) return;
      frame = requestAnimationFrame(fitTerminal);
    };
    const applyAppearance = () => {
      if (disposed || document.hidden) { appearanceDirty = true; return; }
      appearanceDirty = false;
      term.options.theme = themedTerminal(appearanceRef.current.themeId) ?? terminalTheme();
      term.options.fontFamily = fontFamilyOf(appearanceRef.current.fontFamily);
      term.options.lineHeight = appearanceRef.current.lineHeight;
      term.options.cursorStyle = appearanceRef.current.cursorStyle;
      term.refresh(0, term.rows - 1);
      scheduleFit();
    };
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else {
        if (appearanceDirty) applyAppearance();
        scheduleFit();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    // A delayed attachment must not take focus back after the user moves on.
    const onInteraction = (event: Event) => {
      if (!host.contains(event.target as Node)) mayFocus = false;
    };
    const stopWatchingFocus = () => {
      document.removeEventListener('focusin', onInteraction, true);
      document.removeEventListener('pointerdown', onInteraction, true);
      document.removeEventListener('keydown', onInteraction, true);
    };
    document.addEventListener('focusin', onInteraction, true);
    document.addEventListener('pointerdown', onInteraction, true);
    document.addEventListener('keydown', onInteraction, true);
    // The bundled face works offline. Repaint after it loads: xterm may have
    // already painted shell output using the system fallback on first open.
    void document.fonts.load('14px "Studio Terminal Symbols"', '\uf07b\uf15b\ue0b0\udb80\udf7b').then(() => {
      if (disposed) return;
      setFontWarning(false);
      applyAppearance();
    }).catch(() => {
      // A missing optional symbol face must not block a working shell.
      if (!disposed) setFontWarning(true);
    });
    fitTerminal();

    const failSynchronization = () => {
      failed = true;
      ready = false;
      pending.length = 0;
      pendingChars = 0;
      stopWatchingFocus();
      setConnecting(false);
      setError('终端输出同步中断，请重新连接以恢复最近内容。');
    };
    const applyEvent = (event: TerminalEvent) => {
      if (disposed || failed || event.id !== id) return;
      if (!ready) {
        // The main process owns the bounded replay buffer. Cap events that
        // arrive before terminalCreate() resolves so a noisy PTY cannot grow
        // the renderer queue without a limit.
        if (event.type === 'data') pendingChars += event.data.length;
        pending.push(event);
        while (pending.length > MAX_PENDING_EVENTS || pendingChars > MAX_PENDING_CHARS) {
          const removed = pending.shift();
          if (removed?.type === 'data') {
            pendingChars -= removed.data.length;
            droppedSequence = Math.max(droppedSequence, removed.sequence);
          }
        }
        return;
      }
      if (event.type === 'data') {
        if (event.sequence <= restoredSequence) return;
        // Applying an ANSI continuation after missing output corrupts the
        // screen/parser. Keep the last intact display and offer a fresh attach.
        if (event.sequence !== restoredSequence + 1) { failSynchronization(); return; }
        restoredSequence = event.sequence;
        term.write(event.data);
      } else {
        setStatus(event.status);
        setExitCode(event.exitCode);
      }
    };
    const unsubscribe = window.piApi.onTerminalEvent(applyEvent);
    const input = term.onData((data) => {
      if (disposed || !ready) return;
      void window.piApi.terminalWrite(id, data).catch((cause) => {
        if (!disposed) setError(errorText(cause));
      });
    });
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(host);
    const appearanceObserver = new MutationObserver(applyAppearance);
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette', 'style'],
    });

    void window.piApi.terminalCreate({
      id,
      cwd,
      cols: term.cols || 90,
      rows: term.rows || 24,
      shellIntegration,
    }).then(async (snapshot) => {
      if (disposed) return;
      setShell(snapshot.shell);
      setWorkingDirectory(snapshot.cwd);
      setStatus(snapshot.status);
      setExitCode(snapshot.exitCode);
      // A noisy PTY may overflow the attachment queue. Dropped events are safe
      // only when the authoritative snapshot already includes all of them.
      if (droppedSequence > snapshot.sequence) { failSynchronization(); return; }
      restoredSequence = snapshot.sequence;
      if (snapshot.replay) {
        restoring = true;
        const restored = await restoreTerminalReplay(term, snapshot.replay, () => !disposed && !failed);
        restoring = false;
        if (!restored) return;
        setHistoryTruncated(snapshot.replay.truncated);
      }
      if (disposed) return;
      if (droppedSequence > snapshot.sequence) { failSynchronization(); return; }
      ready = true;
      setConnecting(false);
      for (const event of pending.splice(0)) {
        if (event.type === 'data' && event.sequence <= restoredSequence) continue;
        applyEvent(event);
      }
      pendingChars = 0;
      if (failed) return;
      scheduleFit();
      if (mayFocus && !document.hidden && document.hasFocus() && host.isConnected) term.focus();
      stopWatchingFocus();
    }).catch((cause) => {
      if (disposed) return;
      failed = true;
      restoring = false;
      pending.length = 0;
      pendingChars = 0;
      stopWatchingFocus();
      setConnecting(false);
      setError(errorText(cause));
    });

    return () => {
      disposed = true;
      ready = false;
      stopWatchingFocus();
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(frame);
      unsubscribe();
      input.dispose();
      resizeObserver.disconnect();
      appearanceObserver.disconnect();
      fileLinks.dispose();
      oscSubscription.dispose();
      for (const entry of commandMarks) entry.decoration?.dispose();
      searchResults.dispose();
      titleSubscription.dispose();
      serializeRef.current = null;
      term.dispose();
      terminalRef.current = null;
      searchRef.current = null;
      fitRef.current = null;
      focusTerminalRef.current = null;
    };
  }, [cwd, id, retryRevision, openLink]);

  // 主题、字体、行高、光标：只改渲染参数，不重建会话。
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    const previous = appliedAppearanceRef.current;
    if (previous.themeId === appearance.themeId
      && previous.fontFamily === appearance.fontFamily
      && previous.lineHeight === appearance.lineHeight
      && previous.cursorStyle === appearance.cursorStyle) return;
    appliedAppearanceRef.current = appearance;
    term.options.theme = themedTerminal(appearance.themeId) ?? terminalTheme();
    term.options.fontFamily = fontFamilyOf(appearance.fontFamily);
    term.options.lineHeight = appearance.lineHeight;
    term.options.cursorStyle = appearance.cursorStyle;
    fitRef.current?.();
    term.refresh(0, term.rows - 1);
  }, [appearance.themeId, appearance.fontFamily, appearance.lineHeight, appearance.cursorStyle]);

  // 字号变化只改渲染参数，不重建会话。
  useEffect(() => {
    const term = terminalRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    fitRef.current?.();
    term.refresh(0, term.rows - 1);
    term.focus();
  }, [fontSize]);

  // 面板内的组合键：复制、粘贴、搜索、清屏、缩放、新终端。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing) return;
      const intent = terminalKeyIntent({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        hasSelection: terminalRef.current?.hasSelection() ?? false,
        // 主进程给平台，比 navigator.platform 可靠（后者在测试与 Linux 上常为空）。
        platform: window.piApi.platform === 'darwin' ? 'mac' : 'other',
      });
      if (!intent) return;
      event.preventDefault();
      event.stopPropagation();
      if (intent === 'copy') { void copySelection(); return; }
      if (intent === 'paste') { void pasteFromClipboard(); return; }
      if (intent === 'select-all') { terminalRef.current?.selectAll(); return; }
      if (intent === 'search') { openSearch(); return; }
      if (intent === 'clear') { clearScreen(); return; }
      if (intent === 'new-terminal') { onNewTerminal(); return; }
      if (intent === 'zoom-in') { zoom(1); return; }
      if (intent === 'zoom-out') { zoom(-1); return; }
      if (intent === 'zoom-reset') onFontSizeChange(12);
      if (intent === 'prev-command') jumpCommand(-1);
      if (intent === 'next-command') jumpCommand(1);
    };
    host.addEventListener('keydown', onKeyDown, true);
    return () => host.removeEventListener('keydown', onKeyDown, true);
  }, [clearScreen, copySelection, jumpCommand, onFontSizeChange, onNewTerminal, openSearch, pasteFromClipboard, zoom]);

  // 搜索结果随输入实时高亮，⌘F 打开时预先放入当前选区。
  useEffect(() => {
    if (!searchOpen) return;
    const query = searchQuery;
    if (!query) { searchRef.current?.clearDecorations(); return; }
    searchRef.current?.findNext(query, {
      incremental: true,
      // xterm 的取色器不认识 color-mix()，这里只用具体的语义色。
      decorations: {
        matchBackground: token('--warning-soft'),
        activeMatchBackground: token('--warning-soft'),
        matchOverviewRuler: token('--warning'),
        activeMatchColorOverviewRuler: token('--warning'),
      },
    });
  }, [searchOpen, searchQuery]);

  const running = !connecting && status === 'running' && !error;
  const activePalette = themedTerminal(appearance.themeId);
  return <section
    className={`terminal-panel ${activePalette ? 'has-custom-theme' : ''}`}
    aria-label="终端"
    style={activePalette
      ? { background: activePalette.background, ['--terminal-fg' as string]: activePalette.foreground }
      : undefined}
  >
    <header className="terminal-toolbar">
      <span className={`terminal-live-state ${running ? 'is-running' : 'is-exited'}`}>
        <i aria-hidden="true" />
        {connecting ? '连接中' : error ? '未连接' : running ? '运行中' : status === 'exited' ? `已退出${exitCode === undefined ? '' : ` · ${exitCode}`}` : '未连接'}
      </span>
      <span className="terminal-shell"><TerminalIcon aria-hidden="true" />{shell || 'shell'}</span>
      <code title={workingDirectory}>{workingDirectory}</code>
      {failedCommands > 0 && <button
        type="button"
        className="terminal-failures"
        aria-label={`${failedCommands} 条命令失败，跳到最近一条`}
        title={`${failedCommands} 条命令失败，点击跳到最后一条`}
        onClick={jumpToFailure}
      ><TriangleAlert aria-hidden="true" />{failedCommands}</button>}
      {fontWarning && <span className="terminal-font-warning" role="status" aria-label="图标字体加载失败，请重新连接终端" title="图标字体加载失败，请重新连接终端"><TriangleAlert aria-hidden /></span>}
      <button type="button" aria-label="搜索终端输出" title="搜索终端输出 ⌘F" onClick={openSearch}><Search /></button>
      <button type="button" aria-label="清屏" title="清屏 ⌘K" onClick={clearScreen}><Eraser /></button>
      <button type="button" aria-label="新建终端" title="新建终端 ⌘T" onClick={onNewTerminal}><Plus /></button>
      <button type="button" aria-label="重新连接终端" title="重新连接" onClick={() => setRetryRevision((value) => value + 1)}><RotateCw /></button>
      <button
        ref={moreButtonRef}
        type="button"
        aria-label="更多终端操作"
        title="更多"
        onClick={() => {
          const rect = moreButtonRef.current?.getBoundingClientRect();
          if (rect) setMoreMenu({ x: rect.right - 8, y: rect.bottom + 4 });
        }}
      ><MoreHorizontal /></button>
    </header>
    {searchOpen && <div className="terminal-search" role="search">
      <Search aria-hidden="true" />
      <input
        ref={searchInputRef}
        value={searchQuery}
        autoFocus
        placeholder="搜索输出"
        aria-label="搜索终端输出"
        onChange={(event) => setSearchQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false); setSearchQuery(''); terminalRef.current?.focus(); return; }
          if (event.key === 'Enter') {
            event.preventDefault();
            if (!searchQuery) return;
            if (event.shiftKey) searchRef.current?.findPrevious(searchQuery);
            else searchRef.current?.findNext(searchQuery);
          }
        }}
      />
      <span className="terminal-search-hits" aria-live="polite">
        {searchHits.count === 0 ? (searchQuery ? '0' : '') : `${searchHits.index + 1}/${searchHits.count}`}
      </span>
      <button type="button" aria-label="上一个结果" title="上一个 ⇧Enter" onClick={() => searchQuery && searchRef.current?.findPrevious(searchQuery)}><ChevronUp /></button>
      <button type="button" aria-label="下一个结果" title="下一个 Enter" onClick={() => searchQuery && searchRef.current?.findNext(searchQuery)}><ChevronDown /></button>
      <button type="button" aria-label="跳到最新" title="跳到最新" onClick={scrollToBottom}><ArrowDownToLine /></button>
      <button type="button" aria-label="关闭搜索" title="关闭" onClick={() => { setSearchOpen(false); setSearchQuery(''); terminalRef.current?.focus(); }}><X /></button>
    </div>}
    {pendingPaste !== null && <div className="terminal-paste-confirm" role="status">
      <span>粘贴 {pendingPaste.split('\n').length} 行命令？确认会直接写入终端。</span>
      <div>
        <button type="button" className="is-primary" onClick={() => { const text = pendingPaste; setPendingPaste(null); writeToPty(text); }}>粘贴</button>
        <button type="button" onClick={() => setPendingPaste(null)}>取消</button>
      </div>
    </div>}
    {historyTruncated && <div className="terminal-history-note" role="status">较早输出已清理，历史画面可能不完整。</div>}
    <div className="terminal-stage">
      <div
        ref={hostRef}
        className="terminal-host"
        aria-label="交互式终端"
        onPointerDown={() => focusTerminalRef.current?.()}
        onFocus={() => focusTerminalRef.current?.()}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files);
          if (files.length === 0) return;
          event.preventDefault();
          const text = files
            .map((file) => shellQuotePath(window.piApi.filePathOf(file)))
            .filter(Boolean)
            .join(' ');
          if (!text) return;
          terminalRef.current?.paste(text);
          terminalRef.current?.focus();
        }}
      />
      {error && <div className="terminal-error" role="alert">
        <strong>终端连接异常</strong>
        <span>{error}</span>
        <button type="button" onClick={() => { setError(null); setRetryRevision((value) => value + 1); }}>重试</button>
      </div>}
    </div>
    {menu && <ActionMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuActions} />}
    {moreMenu && <ActionMenu x={moreMenu.x} y={moreMenu.y} onClose={() => setMoreMenu(null)} items={menuActions} />}
  </section>;
}
