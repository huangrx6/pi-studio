import './styles/settings-section-navigation.css';

export function SettingsSectionNavigation({
  label,
  sections,
}: {
  label: string;
  sections: readonly { id: string; label: string }[];
}) {
  return <nav className="settings-section-navigation" aria-label={label}>
    {sections.map(section => <a key={section.id} href={`#${section.id}`} onClick={(event) => {
      const heading = document.getElementById(section.id);
      if (!heading) return;
      event.preventDefault();
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      heading.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
    }}>{section.label}</a>)}
  </nav>;
}
