import { useEffect, useRef, useState } from 'react';
import { Plus, RotateCw, Terminal as TerminalIcon, TriangleAlert } from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalEvent, TerminalSessionStatus } from '../../types/runtime-panel-types';
import { errorText } from '../../shared/error-text';
import { restoreTerminalReplay } from './terminal-replay';
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

export function TerminalPanel({
  id,
  cwd,
  onNewTerminal,
}: {
  id: string;
  cwd: string;
  onNewTerminal: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const focusTerminalRef = useRef<(() => void) | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [status, setStatus] = useState<TerminalSessionStatus>('running');
  const [exitCode, setExitCode] = useState<number | undefined>();
  const [shell, setShell] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState(cwd);
  const [error, setError] = useState<string | null>(null);
  const [fontWarning, setFontWarning] = useState(false);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [retryRevision, setRetryRevision] = useState(0);

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
    const term = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: terminalFontFamily(),
      fontSize: Math.max(11, Math.min(16, Number.parseFloat(token('--chat-font-size')) || 12)),
      lineHeight: 1.25,
      scrollback: 8_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
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
      term.options.theme = terminalTheme();
      term.options.fontFamily = terminalFontFamily();
      term.options.fontSize = Math.max(11, Math.min(16, Number.parseFloat(token('--chat-font-size')) || 12));
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
      term.dispose();
      focusTerminalRef.current = null;
    };
  }, [cwd, id, retryRevision]);

  const running = !connecting && status === 'running' && !error;
  return <section className="terminal-panel" aria-label="终端">
    <header className="terminal-toolbar">
      <span className={`terminal-live-state ${running ? 'is-running' : 'is-exited'}`}>
        <i aria-hidden="true" />
        {connecting ? '连接中' : error ? '未连接' : running ? '运行中' : status === 'exited' ? `已退出${exitCode === undefined ? '' : ` · ${exitCode}`}` : '未连接'}
      </span>
      <span className="terminal-shell"><TerminalIcon aria-hidden="true" />{shell || 'shell'}</span>
      <code title={workingDirectory}>{workingDirectory}</code>
      {fontWarning && <span className="terminal-font-warning" role="status" aria-label="图标字体加载失败，请重新连接终端" title="图标字体加载失败，请重新连接终端"><TriangleAlert aria-hidden /></span>}
      <button type="button" aria-label="新建终端" title="新建终端" onClick={onNewTerminal}><Plus /></button>
      <button type="button" aria-label="重新连接终端" title="重新连接" onClick={() => setRetryRevision((value) => value + 1)}><RotateCw /></button>
    </header>
    {historyTruncated && <div className="terminal-history-note" role="status">较早输出已清理，历史画面可能不完整。</div>}
    <div className="terminal-stage">
      <div
        ref={hostRef}
        className="terminal-host"
        aria-label="交互式终端"
        onPointerDown={() => focusTerminalRef.current?.()}
        onFocus={() => focusTerminalRef.current?.()}
      />
      {error && <div className="terminal-error" role="alert">
        <strong>终端连接异常</strong>
        <span>{error}</span>
        <button type="button" onClick={() => { setError(null); setRetryRevision((value) => value + 1); }}>重试</button>
      </div>}
    </div>
  </section>;
}
