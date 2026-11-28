export function PermissionPresetGlyph({ preset, className = 'perm-preset-glyph' }: {
  preset?: string;
  className?: string;
}) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2.75 4.5 5.75v5.6c0 4.65 3.15 8.55 7.5 9.9 4.35-1.35 7.5-5.25 7.5-9.9v-5.6L12 2.75Z" />
    {preset === 'ask' && <>
      <rect x="9.25" y="11" width="5.5" height="4.25" rx="1" />
      <path d="M10.4 11V9.5a1.6 1.6 0 0 1 3.2 0V11" />
    </>}
    {preset === 'smart' && (
      <path d="m9.25 12.1 1.9 1.9 3.7-3.8" />
    )}
    {preset !== 'ask' && preset !== 'smart' && (
      <path d="M12.6 8.2 9.6 12.5h2.5l-.7 3.3 3-4.3h-2.5l.7-3.3Z" />
    )}
  </svg>;
}
