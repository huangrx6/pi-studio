export type AgentToolSourceKind = 'core' | 'package' | 'git' | 'local' | 'inline' | 'extension';

export interface AgentToolSource {
  key: string;
  source: string;
  label: string;
  kind: AgentToolSourceKind;
  scope: string;
  path: string;
  baseDir: string;
}

export interface AgentToolSourceSnapshot {
  source: string;
  label: string;
  scope: string;
  path: string;
  baseDir: string;
}

export interface AgentToolInfo {
  name: string;
  description: string;
  exposure: string;
  source: AgentToolSource;
}

export interface AgentToolCommand {
  name: string;
  description: string;
  source: AgentToolSource;
}

export interface AgentToolSelection {
  enabled: string[];
  /** 工具最近一次被发现时的来源；扩展暂时卸载后仍用于提示来源。 */
  sources: Record<string, AgentToolSourceSnapshot>;
}

export interface AgentToolCatalog {
  tools: AgentToolInfo[];
  commands: AgentToolCommand[];
  errors: Array<{ path: string; message: string }>;
  warnings: Array<{ path: string; message: string }>;
  /** Studio-owned SQLite location for the persisted tool selection. */
  storage: string;
  refreshedAt: number;
}
