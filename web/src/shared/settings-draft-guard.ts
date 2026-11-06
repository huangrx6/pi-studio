export type SettingsDraft = {
  label: string;
  dirty: boolean;
  /** Only exempt pending writes whose owner restores failed drafts after unmount. */
  saving?: boolean;
};

/** Registers only edit state; form values and credentials stay in their owners. */
export function createSettingsDraftGuard() {
  const editors = new Map<symbol, () => SettingsDraft>();
  let deciding = false;
  const labels = () => [...new Set([...editors.values()].map(read => read()).filter(draft => draft.dirty && !draft.saving).map(draft => draft.label))];
  return {
    register(owner: symbol, read: () => SettingsDraft) {
      editors.set(owner, read);
      return () => { if (editors.get(owner) === read) editors.delete(owner); };
    },
    labels,
    async canLeave(confirm: (labels: string[]) => Promise<boolean>): Promise<boolean> {
      // A second menu or native event cannot replace the destination being reviewed.
      if (deciding) return false;
      const unsaved = labels();
      if (!unsaved.length) return true;
      deciding = true;
      try { return await confirm(unsaved); }
      finally { deciding = false; }
    },
  };
}
export type SettingsDraftGuard = ReturnType<typeof createSettingsDraftGuard>;
