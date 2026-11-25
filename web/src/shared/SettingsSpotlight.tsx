import type { ReactNode } from 'react';
import archives from '../../../assets/settings/archive-folder.webp';
import mcp from '../../../assets/settings/mcp-connection.webp';
import skills from '../../../assets/settings/skill-guide.webp';
import './styles/settings-spotlight.css';

const artwork = { archives, mcp, skills };

export function SettingsSpotlight({
  art,
  title,
  titleId,
  heading = 'h2',
  description,
  actions,
  compact = false,
  className = '',
}: {
  art: keyof typeof artwork;
  title: string;
  titleId?: string;
  heading?: 'h2' | 'h3';
  description: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const Heading = heading;
  return <div className={`settings-spotlight${compact ? ' is-compact' : ''} ${className}`.trim()} aria-labelledby={titleId}>
    <div className="settings-spotlight-copy">
      <Heading id={titleId}>{title}</Heading>
      <p>{description}</p>
      {actions && <div className="settings-spotlight-actions">{actions}</div>}
    </div>
    <span className="settings-spotlight-art" data-art={art} aria-hidden="true">
      <img src={artwork[art]} alt="" width="120" height="120" decoding="async" />
    </span>
  </div>;
}
