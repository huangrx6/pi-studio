import type { AgentToolSelection } from '../../types/agent-tool-types';

type ToolWriteState = { pending: boolean; failure: { draft: AgentToolSelection; message: string } | null };

/** Tool selection is global. Route changes retain both its lock and failed draft. */
export function createToolWriteCoordinator() {
  let state: ToolWriteState = { pending: false, failure: null };
  const listeners = new Set<() => void>();
  const publish = (next: ToolWriteState) => { state = next; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    clearFailure() { if (!state.pending && state.failure) publish({ pending: false, failure: null }); },
    reportSavedWarning(draft: AgentToolSelection, message: string) {
      if (!state.pending) publish({ pending: false, failure: { draft, message } });
    },
    async run<T>(draft: AgentToolSelection, write: () => Promise<T>): Promise<T> {
      if (state.pending) throw new Error('工具配置正在保存，请稍后再试。');
      publish({ pending: true, failure: null });
      try {
        const result = await write();
        publish({ pending: false, failure: null });
        return result;
      } catch (cause) {
        publish({ pending: false, failure: { draft, message: cause instanceof Error ? cause.message : String(cause) } });
        throw cause;
      }
    },
  };
}

export const toolWrites = createToolWriteCoordinator();
