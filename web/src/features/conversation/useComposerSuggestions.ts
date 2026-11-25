import { useEffect, useMemo, useState } from 'react';
import type { ComposerCapability, ComposerCommand, ComposerFile, ComposerMentionOption } from '../../types/chat-types';
import { refreshSubagentProfiles, useSubagentProfiles } from '../subagents/useSubagentProfiles';
import { errorText } from '../../shared/error-text';

import type { ComposerMenuState } from './composer-menu';
export type { ComposerMenuState } from './composer-menu';
type Suggestions = { key: string; commandScope: string; commands: ComposerCommand[]; files: ComposerFile[]; capabilities: ComposerCapability[]; loading: boolean; error: string | null };
const EMPTY_COMMANDS: ComposerCommand[] = [];
const EMPTY_FILES: ComposerFile[] = [];

/** Menu requests own their context. Closing or replacing a menu invalidates its response. */
export function useComposerSuggestions(menu: ComposerMenuState | null, cwd: string, sessionId?: string) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Suggestions>({ key: '', commandScope: '', commands: [], files: [], capabilities: [], loading: false, error: null });
  const scope = JSON.stringify([cwd, sessionId]);
  const kind = menu?.kind === 'capability' && !menu.capabilityType ? undefined : menu?.kind;
  const profiles = useSubagentProfiles(kind === 'agent');
  const query = kind === 'file' ? menu?.query || '' : '';
  const key = kind ? JSON.stringify([scope, kind, query, revision]) : '';
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loading = Boolean(kind && kind !== 'agent' && (kind !== 'file' || cwd));
    setResult(previous => ({ ...previous, key, files: [], loading, error: null }));
    if (!loading) return () => { current = false; };
    const read = async () => {
      try {
        if (kind === 'slash' || kind === 'capability') {
          const data = await window.piApi.composerResources({ cwd, sessionId, includeCapabilities: kind === 'capability' });
          if (current) setResult({ key, commandScope: scope, commands: [...data.commands, ...data.skills], files: [], capabilities: data.capabilities || [], loading: false, error: null });
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
  const loading = Boolean(kind && kind !== 'agent' && (kind !== 'file' || cwd) && (!matches || result.loading));
  const error = matches ? result.error : null;
  const commands = result.commandScope === scope ? result.commands : EMPTY_COMMANDS;
  const commandQuery = menu?.query || '';
  const commandOptions = useMemo(() => kind === 'slash' && matches && !loading && !error
    ? commands.filter(command => `${command.name} ${command.description}`.toLowerCase().includes(commandQuery.toLowerCase()))
      .sort((left, right) => ['builtin', 'skill', 'prompt', 'extension'].indexOf(left.source) - ['builtin', 'skill', 'prompt', 'extension'].indexOf(right.source))
    : EMPTY_COMMANDS, [kind, matches, loading, error, commands, commandQuery]);
  const mentionOptions = useMemo<ComposerMentionOption[]>(() => {
    const needle = commandQuery.trim().toLocaleLowerCase();
    if (kind === 'agent') return profiles.rows
      .filter(role => (role.name + ' ' + role.description).toLocaleLowerCase().includes(needle))
      .map(({ id, name, avatarId, description }) => ({ type: 'agent', id, name, avatarId, description }));
    if (!matches || loading || error) return EMPTY_FILES;
    if (kind === 'file') return result.files;
    if (kind === 'capability') {
      const contains = (value: string) => value.toLocaleLowerCase().includes(needle);
      if (menu?.capabilityType === 'mcp') {
        const server = menu.mcpServer;
        if (server) return result.capabilities.filter(item => item.type === 'mcp' && item.serverId === server.id
          && contains([item.name, item.originalDescription || item.description].join(' ')));
        const servers = result.capabilities.filter(item => item.type === 'mcp-server'
          && contains([item.name, item.description, item.source, 'MCP'].join(' ')));
        if (!needle) return servers;
        // Let users search for a method without first opening its server.
        return [...servers, ...result.capabilities.filter(item => item.type === 'mcp'
          && (contains(item.name) || (needle.includes('/') && contains(item.server + '/' + item.name))))];
      }
      return result.capabilities.filter(item => item.type === menu?.capabilityType
        && contains([item.name, item.description, item.source, item.type === 'plugin' ? '插件 ' + item.id : '技能'].join(' ')));
    }
    return EMPTY_FILES;
  }, [kind, profiles.rows, commandQuery, matches, loading, error, result.files, result.capabilities, menu?.capabilityType, menu?.mcpServer]);
  return {
    commands,
    commandOptions,
    mentions: mentionOptions,
    loading: loading || (kind === 'agent' && !profiles.ready && !profiles.error),
    error: error || (kind === 'agent' ? profiles.error : ''),
    retry: () => {
      if (kind === 'agent') void refreshSubagentProfiles();
      setRevision(value => value + 1);
    },
  };
}
