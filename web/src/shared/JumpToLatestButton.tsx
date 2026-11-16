import { ArrowDown } from 'lucide-react';
import { LoadingIndicator } from './LoadingState';
import './styles/jump-to-latest.css';

/** Place beside the scroller inside its positioned viewport. */
export function JumpToLatestButton({ label = '回到最新消息', busy = false, onClick }: {
  label?: string;
  busy?: boolean;
  onClick: () => void;
}) {
  return <button type="button" className="jump-to-latest" aria-label={label} title={label}
    aria-busy={busy || undefined} disabled={busy} onClick={onClick}>
    {busy ? <LoadingIndicator /> : <ArrowDown aria-hidden="true" />}
  </button>;
}
