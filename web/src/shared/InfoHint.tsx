import { useId } from 'react';
import { Info } from 'lucide-react';
import './info-hint.css';

export function InfoHint({
  label,
  align = 'start',
  className = '',
}: {
  label: string;
  align?: 'start' | 'end';
  className?: string;
}) {
  const tooltipId = useId();
  return <button
    type="button"
    className={`info-hint is-${align}${className ? ` ${className}` : ''}`}
    aria-label={label}
    aria-describedby={tooltipId}
    onClick={(event) => event.stopPropagation()}
  >
    <Info aria-hidden="true" />
    <span id={tooltipId} className="info-hint-tooltip" role="tooltip">{label}</span>
  </button>;
}
