import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  EMPTY_PERMISSION_UI_STATE,
  permissionScopeKey,
  type PermissionMode,
  type PermissionUiState,
} from './app-shell-config';
import { errorText } from '../shared/error-text';

type Setter<T> = Dispatch<SetStateAction<T>>;

type PermissionControlDependencies = {
  workspace: string;
  sessionId?: string;
  setError: Setter<string | null>;
};

export function usePermissionControl({
  workspace,
  sessionId,
  setError,
}: PermissionControlDependencies) {
  const [permission, setPermission] = useState<PermissionUiState>(EMPTY_PERMISSION_UI_STATE);
  const permissionReadRequestRef = useRef(0);
  const permissionWriteRequestRef = useRef(0);
  const [fullPermissionOpen, setFullPermissionOpen] = useState(false);
  const [fullPermissionAck, setFullPermissionAck] = useState(false);
  const activePermissionScopeKey = permissionScopeKey(workspace, sessionId);
  const permissionScopeKeyRef = useRef(activePermissionScopeKey);
  permissionScopeKeyRef.current = activePermissionScopeKey;
  const visiblePermission = permission.scopeKey === activePermissionScopeKey ? permission : null;

  useEffect(() => {
    const scopeKey = permissionScopeKey(workspace, sessionId);
    const request = ++permissionReadRequestRef.current;
    ++permissionWriteRequestRef.current;
    setPermission((current) => current.scopeKey === scopeKey
      ? { ...current, status: 'loading' }
      : { scopeKey, available: false, mode: 'smart', status: 'loading' });
    void readPermissionForScope(scopeKey, {
      cwd: workspace || undefined,
      sessionId,
    }, request);
    return () => {
      if (permissionReadRequestRef.current === request) ++permissionReadRequestRef.current;
    };
  }, [workspace, sessionId]);

  async function readPermissionForScope(
    scopeKey: string,
    payload: { cwd?: string; sessionId?: string },
    request: number,
  ) {
    try {
      const state = await window.piApi.modeGet(payload);
      if (
        request !== permissionReadRequestRef.current
        || permissionScopeKeyRef.current !== scopeKey
      ) return;
      setPermission({ scopeKey, available: state.available, mode: state.mode, status: 'ready' });
    } catch {
      if (
        request === permissionReadRequestRef.current
        && permissionScopeKeyRef.current === scopeKey
      ) {
        setPermission({ scopeKey, available: false, mode: 'smart', status: 'error' });
      }
    }
  }

  function retryPermissionMode() {
    const scopeKey = permissionScopeKeyRef.current;
    const request = ++permissionReadRequestRef.current;
    ++permissionWriteRequestRef.current;
    setPermission({ scopeKey, available: false, mode: 'smart', status: 'loading' });
    return readPermissionForScope(scopeKey, {
      cwd: workspace || undefined,
      sessionId,
    }, request);
  }

  /** Settings may save a different policy layer; only accept the current scope's effective state. */
  function acceptPermissionState(state: { available: boolean; mode: PermissionMode }) {
    const scopeKey = permissionScopeKeyRef.current;
    ++permissionReadRequestRef.current;
    ++permissionWriteRequestRef.current;
    setPermission({ scopeKey, available: state.available, mode: state.mode, status: 'ready' });
  }

  /** 真正应用权限模式：先乐观更新，失败时回滚并提示。 */
  async function applyPermission(mode: PermissionMode) {
    const previous = visiblePermission;
    if (!previous?.available) return;
    const scopeKey = permissionScopeKeyRef.current;
    const request = ++permissionWriteRequestRef.current;
    ++permissionReadRequestRef.current;
    setPermission({ scopeKey, available: true, mode, status: 'ready' });
    await writePermissionForScope(
      scopeKey,
      {
        mode,
        scope: sessionId ? 'session' : 'user',
        cwd: workspace || undefined,
        sessionId,
      },
      request,
      previous,
    );
  }

  async function writePermissionForScope(
    scopeKey: string,
    payload: {
      mode: PermissionMode;
      scope: 'user' | 'session';
      cwd?: string;
      sessionId?: string;
    },
    request: number,
    previous: PermissionUiState,
  ) {
    try {
      const state = await window.piApi.modeSet(payload);
      if (
        request !== permissionWriteRequestRef.current
        || permissionScopeKeyRef.current !== scopeKey
      ) return;
      setPermission({ scopeKey, available: state.available, mode: state.mode, status: 'ready' });
    } catch (error) {
      if (
        request === permissionWriteRequestRef.current
        && permissionScopeKeyRef.current === scopeKey
      ) {
        setPermission(previous);
        setError(errorText(error));
      }
    }
  }

  /** 切换权限模式：选择「完全权限」时先要求确认风险。 */
  async function changePermission(mode: PermissionMode) {
    if (!visiblePermission) return;
    if (mode === 'full' && visiblePermission.mode !== 'full') {
      setFullPermissionAck(false);
      setFullPermissionOpen(true);
      return;
    }
    await applyPermission(mode);
  }

  return {
    visiblePermission,
    retryPermissionMode,
    acceptPermissionState,
    applyPermission,
    changePermission,
    fullPermissionOpen,
    setFullPermissionOpen,
    fullPermissionAck,
    setFullPermissionAck,
  };
}
