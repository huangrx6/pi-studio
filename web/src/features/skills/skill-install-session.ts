import type { SettingsSnapshot } from '../../global.d';

export type SkillInstallResult = Awaited<ReturnType<typeof window.piApi.installPreparedSkill>>;
export type SkillInstallState = { busy: boolean; attempted: boolean; result: SkillInstallResult | null; error: string; complete: boolean };

/** One prepared token, one write. Recovery resumes only the unfinished read/callback. */
export function createSkillInstallSession(deps: {
  install: (payload: { token: string; cwd: string }) => Promise<SkillInstallResult>;
  refresh: (cwd: string) => Promise<SettingsSnapshot>;
  onCommitted?: (result: SkillInstallResult, cwd: string) => void;
  onInstalled: (result: SkillInstallResult, cwd: string) => void | Promise<void>;
  onChange: (state: SkillInstallState) => void;
}) {
  let live = true, locked = false, cwd = '';
  let state: SkillInstallState = { busy: false, attempted: false, result: null, error: '', complete: false };
  const publish = (patch: Partial<SkillInstallState>) => { state = { ...state, ...patch }; if (live) deps.onChange(state); };
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  async function finish() {
    if (!live || !state.result) return;
    if (state.result.projection.status === 'error') {
      try {
        const settings = await deps.refresh(cwd);
        if (!live) return;
        publish({ result: { ...state.result, projection: { status: 'ready', value: settings } } });
      } catch (error) {
        if (live) publish({ error: `技能已安装，但刷新未完成。${message(error)}` });
        return;
      }
    }
    try {
      await deps.onInstalled(state.result!, cwd);
      if (live) publish({ complete: true, busy: false });
    } catch (error) {
      if (live) publish({ error: `技能已安装，但页面更新未完成。${message(error)}` });
    }
  }
  async function run(task: () => Promise<void>) {
    if (!live || locked || state.complete) return;
    locked = true; publish({ busy: true, error: '' });
    try { await task(); }
    finally { locked = false; if (live && !state.complete) publish({ busy: false }); }
  }
  return {
    get state() { return state; },
    dispose() { live = false; },
    install(token: string, targetCwd: string) {
      if (state.attempted || !token) return Promise.resolve();
      return run(async () => {
        cwd = targetCwd; publish({ attempted: true });
        let result: SkillInstallResult;
        try { result = await deps.install({ token, cwd }); }
        catch (error) { if (live) publish({ error: `${message(error)} 请重新预览后再试。` }); return; }
        publish({ result });
        // A single commit notification records persistent recovery outside this
        // preview. Its failure must never cause this token to be installed again.
        try { deps.onCommitted?.(result, cwd); }
        catch (error) { if (live) publish({ error: `技能已安装，但完成通知未更新。${message(error)}` }); return; }
        if (!live) return;
        if (result.projection.status === 'error') { publish({ error: result.projection.message }); return; }
        await finish();
      });
    },
    retry() { return state.result ? run(finish) : Promise.resolve(); },
  };
}
