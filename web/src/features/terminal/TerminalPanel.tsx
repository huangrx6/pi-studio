import { useEffect, useRef, useState } from 'react';
import { Plus, RotateCw, Terminal as TerminalIcon } from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalEvent, TerminalSessionStatus } from '../../types/runtime-panel-types';
import { errorText } from '../../shared/error-text';
import './terminal-panel.css';

const MAX_PENDING_EVENTS = 256;
const MAX_PENDING_CHARS = 1_000_000;

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
  const readyRef = useRef(false);
  const lastSizeRef = useRef('');
  const [status, setStatus] = useState<TerminalSessionStatus>('running');
  const [exitCode, setExitCode] = useState<number | undefined>();
  const [shell, setShell] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState(cwd);
  const [error, setError] = useState<string | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let restoredSequence = 0;
    let frame = 0;
    const pending: TerminalEvent[] = [];
    let pendingChars = 0;
    const term = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: token('--mono'),
      fontSize: Math.max(11, Math.min(16, Number.parseFloat(token('--chat-font-size')) || 12)),
      lineHeight: 1.25,
      scrollback: 8_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    readyRef.current = false;
    lastSizeRef.current = '';
    term.loadAddon(fit);
    term.open(host);

    const fitTerminal = () => {
      if (disposed || !host.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fit.fit();
        const size = `${term.cols}:${term.rows}`;
        if (size !== lastSizeRef.current) {
          lastSizeRef.current = size;
          void window.piApi.terminalResize(id, term.cols, term.rows).catch(() => {});
        }
      } catch {
        // A hidden tab has no measurable geometry; the observer retries on show.
      }
    };
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitTerminal);
    };
    fitTerminal();

    const applyEvent = (event: TerminalEvent) => {
      if (event.id !== id) return;
      if (!readyRef.current) {
        // The main process owns the bounded replay buffer. Cap events that
        // arrive before terminalCreate() resolves so a noisy PTY cannot grow
        // the renderer queue without a limit.
        if (event.type === 'data') pendingChars += event.data.length;
        pending.push(event);
        while (pending.length > MAX_PENDING_EVENTS || pendingChars > MAX_PENDING_CHARS) {
          const removed = pending.shift();
          if (removed?.type === 'data') pendingChars -= removed.data.length;
        }
        return;
      }
      if (event.type === 'data') {
        if (event.sequence <= restoredSequence) return;
        restoredSequence = Math.max(restoredSequence, event.sequence);
        term.write(event.data);
      } else {
        setStatus(event.status);
        setExitCode(event.exitCode);
      }
    };
    const unsubscribe = window.piApi.onTerminalEvent(applyEvent);
    const input = term.onData((data) => {
      if (!readyRef.current) return;
      void window.piApi.terminalWrite(id, data).catch((cause) => {
        if (!disposed) setError(errorText(cause));
      });
    });
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(host);
    const appearanceObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme();
      term.options.fontSize = Math.max(11, Math.min(16, Number.parseFloat(token('--chat-font-size')) || 12));
      scheduleFit();
    });
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette', 'style'],
    });

    void window.piApi.terminalCreate({
      id,
      cwd,
      cols: term.cols || 90,
      rows: term.rows || 24,
    }).then((snapshot) => {
      if (disposed) return;
      setShell(snapshot.shell);
      setWorkingDirectory(snapshot.cwd);
      setStatus(snapshot.status);
      setExitCode(snapshot.exitCode);
      restoredSequence = snapshot.sequence;
      if (snapshot.output) {
        term.reset();
        term.write(snapshot.output);
      }
      readyRef.current = true;
      for (const event of pending.splice(0)) {
        if (event.type === 'data' && event.sequence <= restoredSequence) continue;
        applyEvent(event);
      }
      scheduleFit();
      term.focus();
    }).catch((cause) => {
      if (!disposed) setError(errorText(cause));
    });

    return () => {
      disposed = true;
      readyRef.current = false;
      cancelAnimationFrame(frame);
      unsubscribe();
      input.dispose();
      resizeObserver.disconnect();
      appearanceObserver.disconnect();
      term.dispose();
    };
  }, [cwd, id, retryRevision]);

  const running = status === 'running' && !error;
  return <section className="terminal-panel" aria-label="终端">
    <header className="terminal-toolbar">
      <span className={`terminal-live-state ${running ? 'is-running' : 'is-exited'}`}>
        <i aria-hidden="true" />
        {running ? '运行中' : status === 'exited' ? `已退出${exitCode === undefined ? '' : ` · ${exitCode}`}` : '未连接'}
      </span>
      <span className="terminal-shell"><TerminalIcon aria-hidden="true" />{shell || 'shell'}</span>
      <code title={workingDirectory}>{workingDirectory}</code>
      <button type="button" aria-label="新建终端" title="新建终端" onClick={onNewTerminal}><Plus /></button>
      <button type="button" aria-label="重新连接终端" title="重新连接" onClick={() => setRetryRevision((value) => value + 1)}><RotateCw /></button>
    </header>
    <div className="terminal-stage">
      <div ref={hostRef} className="terminal-host" aria-label="交互式终端" />
      {error && <div className="terminal-error" role="alert">
        <strong>终端无法启动</strong>
        <span>{error}</span>
        <button type="button" onClick={() => { setError(null); setRetryRevision((value) => value + 1); }}>重试</button>
      </div>}
    </div>
  </section>;
}
