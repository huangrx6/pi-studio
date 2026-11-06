import type { AgentToolInfo, AgentToolSelection } from '../../types/agent-tool-types';

export function patternMatches(pattern: string, name: string): boolean {
  if (pattern === name || pattern === '*') return true;
  if (!pattern.includes('*')) return false;
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`).test(name);
}

/** True when two selections name the same unique tools, regardless of order. */
export function sameToolNames(left: string[], right: string[]): boolean {
  if (left.length !== right.length || new Set(left).size !== left.length) return false;
  return right.every((name) => left.includes(name));
}

export function selectionFromSources(enabled: string[], sources: Record<string, AgentToolInfo['source']>, previous: AgentToolSelection): AgentToolSelection {
  return {
    enabled,
    sources: Object.fromEntries(enabled.map((name) => {
      const source = sources[name];
      if (source) {
        return [name, {
          source: source.source,
          label: source.label,
          scope: source.scope,
          path: source.path,
          baseDir: source.baseDir,
        }];
      }
      const stored = previous.sources[name];
      return [name, stored || {
        source: 'manual',
        label: '手动添加',
        scope: 'manual',
        path: '',
        baseDir: '',
      }];
    })),
  };
}

/** Removing one member of a wildcard preserves currently discovered siblings. */
export function toggleToolSelection(enabled: string[], names: string[], name: string, checked: boolean): string[] {
  if (checked) return enabled.some(rule => patternMatches(rule, name)) ? enabled : [...enabled, name];
  const matchingRules = enabled.filter(rule => rule.includes('*') && patternMatches(rule, name));
  if (!matchingRules.length) return enabled.filter(rule => rule !== name);
  return [...new Set([
    ...enabled.filter(rule => rule !== name && !matchingRules.includes(rule)),
    ...names.filter(item => item !== name && matchingRules.some(rule => patternMatches(rule, item))),
  ])];
}
