import { useId, type ReactNode } from 'react';
import './styles/settings-profile-library.css';

export function SettingsProfileLibrary({ title, count, actions, children }: {
  title: string; count: number; actions: ReactNode; children: ReactNode;
}) {
  const titleId = useId();
  return <section className="settings-profile-library" aria-labelledby={titleId}>
    <header className="settings-profile-toolbar">
      <h2 id={titleId}>{title}{count > 0 && <span>{count}</span>}</h2>
      <div className="settings-profile-actions">{actions}</div>
    </header>
    {children}
  </section>;
}
