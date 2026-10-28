import { siAnthropic, siDeepseek, siGooglegemini, siMinimax, siOpencode } from 'simple-icons';

type IconSpec = { path: string };

const providerIcons: Record<string, IconSpec> = {
  deepseek: siDeepseek,
  'minimax-cn': siMinimax,
  minimax: siMinimax,
  opencode: siOpencode,
  'opencode-go': siOpencode,
  anthropic: siAnthropic,
  'google-gemini': siGooglegemini,
  google: siGooglegemini,
};

const tones: Record<string, string> = {
  deepseek: 'is-blue',
  'minimax-cn': 'is-warm',
  minimax: 'is-warm',
  opencode: 'is-green',
  'opencode-go': 'is-green',
  anthropic: 'is-clay',
  'zai-coding-cn': 'is-violet',
  'google-gemini': 'is-sky',
  google: 'is-sky',
};

export function ProviderIcon({ provider, name, icon, size = 22, className = '' }: { provider: string; name?: string; icon?: string; size?: number; className?: string }) {
  const spec = providerIcons[provider];
  const tone = tones[provider] ?? 'is-neutral';
  const style = { width: size, height: size, '--provider-icon-size': `${size}px` } as React.CSSProperties;

  return <span className={`provider-icon ${tone} ${className}`} style={style} title={name || provider}>
    {icon
      ? <img src={icon} alt="" draggable={false} />
      : spec
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d={spec.path} /></svg>
        : <span className="provider-icon-letter">{(name || provider).slice(0, 1).toUpperCase()}</span>}
  </span>;
}
