import { useEffect, useMemo, useState } from 'react';
import type { ComposerCommand, ComposerFile } from '../../types/chat-types';
import { errorText } from '../../shared/error-text';

export type ComposerMenuState = { kind: 'slash' | 'file'; query: string; start: number; end: number };
type Suggestions = { key: string; commandScope: string; commands: ComposerCommand[]; files: ComposerFile[]; loading: boolean; error: string | null };
const EMPTY_COMMANDS: ComposerCommand[] = [];
const EMPTY_FILES: ComposerFile[] = [];

/** Menu requests own their context. Closing or replacing a menu invalidates its response. */
export function useComposerSuggestions(menu: ComposerMenuState | null, cwd: string, sessionId?: string) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Suggestions>({ key: '', commandScope: '', commands: [], files: [], loading: false, error: null });
  const scope = JSON.stringify([cwd, sessionId]);
  const kind = menu?.kind;
  const query = kind === 'file' ? menu?.query || '' : '';
  const key = kind ? JSON.stringify([scope, kind, query, revision]) : '';
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loading = Boolean(kind && (kind !== 'file' || cwd));
    setResult(previous => ({ ...previous, key, files: [], loading, error: null }));
    if (!loading) return () => { current = false; };
    const read = async () => {
      try {
        if (kind === 'slash') {
          const data = await window.piApi.composerResources({ cwd, sessionId });
          if (current) setResult({ key, commandScope: scope, commands: [...data.commands, ...data.skills], files: [], loading: false, error: null });
        } else {
          const data = await window.piApi.searchFiles({ cwd, query });
          if (current) setResult(previous => ({ ...previous, key, files: data.files, loading: false, error: null }));
        }
      } catch (cause) {
        if (current) setResult(previous => ({ ...previous, key, files: [], loading: false, error: errorText(cause) }));
      }
    };
    if (kind === 'file') timer = setTimeout(() => void read(), 120);
    else void read();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [key, kind, cwd, sessionId, scope, query]);
  const matches = result.key === key;
  const loading = Boolean(kind && (kind !== 'file' || cwd) && (!matches || result.loading));
  const error = matches ? result.error : null;
  const commands = result.commandScope === scope ? result.commands : EMPTY_COMMANDS;
  const commandQuery = menu?.query || '';
  const commandOptions = useMemo(() => kind === 'slash' && matches && !loading && !error
    ? commands.filter(command => `${command.name} ${command.description}`.toLowerCase().includes(commandQuery.toLowerCase()))
      .sort((left, right) => ['builtin', 'skill', 'prompt', 'extension'].indexOf(left.source) - ['builtin', 'skill', 'prompt', 'extension'].indexOf(right.source))
    : EMPTY_COMMANDS, [kind, matches, loading, error, commands, commandQuery]);
  return {
    commands,
    commandOptions,
    files: kind === 'file' && matches && !loading && !error ? result.files : EMPTY_FILES,
    loading,
    error,
    retry: () => setRevision(value => value + 1),
  };
}
