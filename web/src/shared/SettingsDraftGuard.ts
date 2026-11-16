import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { SettingsDraft, SettingsDraftGuard } from './settings-draft-guard';

export const SettingsDraftContext = createContext<SettingsDraftGuard | null>(null);

export function useSettingsDraftGuard(draft: SettingsDraft) {
  const guard = useContext(SettingsDraftContext);
  const owner = useRef(Symbol('settings-editor'));
  const latest = useRef(draft);
  latest.current = draft;
  useLayoutEffect(() => guard?.register(owner.current, () => latest.current), [guard]);
}
