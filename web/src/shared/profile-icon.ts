import type { ProfileIcon, ProfileIconGroup } from '../types/profile-icon';

const builtinIcons: Record<ProfileIconGroup, Record<string, ProfileIcon>> = {
  tools: {
    'main-default': { shape: 'baseline', ink: 'ocean' },
    'temporary-default': { shape: 'inset', ink: 'slate' },
  },
  permissions: {
    'strict-ask': { shape: 'baseline', ink: 'ocean' },
    'smart-default': { shape: 'inset', ink: 'teal' },
    'full-access': { shape: 'stagger', ink: 'amber' },
  },
  harness: {
    'studio-coding': { shape: 'baseline', ink: 'berry' },
    'studio-temporary': { shape: 'inset', ink: 'teal' },
  },
};

// Profile copies retain a stable icon assignment for each source ID.
const automaticShapes = ['inset', 'stagger', 'ascending', 'descending', 'foundation'] as const;

export function automaticProfileIcon(group: ProfileIconGroup, id: string): ProfileIcon {
  const builtins = builtinIcons[group];
  if (Object.hasOwn(builtins, id)) return builtins[id];
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { shape: automaticShapes[hash % automaticShapes.length] };
}
