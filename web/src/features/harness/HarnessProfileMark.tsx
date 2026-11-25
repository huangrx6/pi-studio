import catalog from '../../../../assets/settings/harness-profile-icons.json' with { type: 'json' };
import type { HarnessProfileIcon } from '../../types/harness-types';

// Keep the original ID-based assignments even if the picker gains new choices.
const autoShapes = ['inset', 'stagger', 'ascending', 'descending', 'foundation'] as const;
const autoInks = ['ocean', 'berry', 'amber', 'teal'] as const;
export function automaticHarnessIcon(id: string, builtin: boolean): HarnessProfileIcon {
  if (builtin) return { shape: 'baseline', ink: 'teal' };
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { shape: autoShapes[hash % autoShapes.length], ink: autoInks[Math.floor(hash / autoShapes.length) % autoInks.length] };
}

export function HarnessProfileMark({ icon }: { icon: HarnessProfileIcon }) {
  const mark = catalog.shapes[icon.shape];
  return <span className="harness-profile-icon" aria-hidden="true" data-shape={icon.shape} data-ink={icon.ink}>
    <span className="harness-profile-layers" style={{ justifyItems: mark.align }}>
      {mark.widths.map((width, row) => <span key={row} className={row === mark.split ? 'is-split' : undefined}
        style={{ width: width + '%' }} />)}
    </span>
  </span>;
}
