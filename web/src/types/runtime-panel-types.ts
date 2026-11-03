export type TerminalSessionStatus = 'running' | 'exited';

export type TerminalSessionSnapshot = {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  status: TerminalSessionStatus;
  createdAt: number;
  exitedAt?: number;
  exitCode?: number;
  sequence: number;
  output?: string;
  atBottom?: boolean;
  createdNow?: boolean;
};

export type TerminalEvent =
  | { id: string; type: 'data'; data: string; sequence: number }
  | {
      id: string;
      type: 'exit';
      exitCode?: number;
      signal?: number;
      status: TerminalSessionStatus;
    };

export type RuntimeServiceOwnership = 'agent' | 'workspace' | 'app' | 'other';

export type RuntimeService = {
  id: string;
  port: number;
  protocol: 'tcp';
  address: string;
  host: string;
  scope: 'local' | 'all';
  url: string;
  pid: number;
  processName: string;
  command: string;
  cwd?: string;
  elapsedSeconds?: number;
  startedAt?: number;
  ownership: RuntimeServiceOwnership;
  evidence: string[];
  firstObservedAt: number;
  isNew: boolean;
};

export type RuntimeServiceSnapshot = {
  scannedAt: number;
  supported: boolean;
  warning: string;
  services: RuntimeService[];
  summary: {
    total: number;
    related: number;
    agent: number;
    workspace: number;
    other: number;
  };
};

export type RuntimeServiceStopResult = {
  ok: true;
  pid: number;
  port: number;
  affectedPorts: number[];
  forced: boolean;
};
