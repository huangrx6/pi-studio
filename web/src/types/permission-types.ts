export type PermissionMode = 'ask' | 'smart' | 'full';
export type PermissionDecision = 'allow' | 'ask' | 'deny';
export type PermissionScope = 'user' | 'workspace' | 'session';
export type PermissionRememberScope = 'once' | 'session' | 'workspace' | 'always';

export type PermissionRule = {
  id: string;
  label: string;
  decision: PermissionDecision;
  match: {
    tool: string;
    commandPrefix?: string;
    commandExact?: string;
    pathGlob?: string;
    pathExact?: string;
    pathWithin?: 'workspace';
  };
};

export type PermissionPolicy = {
  version: 1;
  preset: PermissionMode;
  default: PermissionDecision;
  tools: Record<string, PermissionDecision>;
  rules: PermissionRule[];
};

export type PermissionPolicyLayer = {
  scope: PermissionScope;
  policy: PermissionPolicy;
};

export type PermissionPolicyState = {
  available: boolean;
  mode: PermissionMode;
  effectivePolicy: PermissionPolicy;
  effectiveScope: PermissionScope;
  layers: PermissionPolicyLayer[];
  cwd: string;
  sessionId: string;
  scopes: {
    user: PermissionPolicy;
    workspace: PermissionPolicy | null;
    session: PermissionPolicy | null;
  };
  catalog: {
    modes: Array<{
      id: PermissionMode;
      label: string;
      description: string;
      defaultDecision: PermissionDecision;
    }>;
    decisions: Array<{ id: PermissionDecision; label: string }>;
    decisionsAreValid: PermissionDecision[];
    presetDefaults: Record<PermissionMode, PermissionDecision>;
  };
  path: string;
};

export type PermissionEvaluation = {
  decision: PermissionDecision;
  explanation: string;
  previewScope?: PermissionScope;
  matched?: {
    decision: PermissionDecision;
    scope: PermissionScope;
    source: 'tool' | 'rule' | 'preset' | 'boundary' | 'bash-static-boundary';
    pattern: string;
    ruleId?: string;
    label?: string;
  };
  matches: Array<{
    decision: PermissionDecision;
    scope: PermissionScope;
    source: 'tool' | 'rule';
    pattern: string;
    ruleId?: string;
    label?: string;
  }>;
  risk: {
    level: 'low' | 'medium' | 'high';
    title: string;
    detail: string;
  };
  context: {
    tool: string;
    command: string;
    path?: string;
  };
  hardProtection?: {
    title: string;
    detail: string;
  };
  rememberScopes: PermissionRememberScope[];
  cwd: string;
  sessionId: string;
};

export type PermissionConfirmRequest = {
  id: string;
  sessionId?: string;
  cwd?: string;
  tool?: string;
  decision?: PermissionDecision;
  explanation?: string;
  risk?: PermissionEvaluation['risk'];
  rememberScopes?: PermissionRememberScope[];
  title: string;
  message: string;
};

export type PermissionConfirmResponse = {
  id: string;
  accepted: boolean;
  remember?: Exclude<PermissionRememberScope, 'once'>;
};
