/**
 * 模型来源（provider）图标。
 *
 * 选择优先级：
 * 1. 主进程返回的自定义 `icon`（图片地址/data URI）——用户可在设置里配置；
 * 2. simple-icons 内置的品牌 path；
 * 3. 名称首字母的字母方块兜底（任何未知来源都不会没有视觉标识）。
 *
 * 纯展示组件；provider id 由设置快照 / 模型目录提供，不涉及 IPC 调用。
 */
import { siAnthropic, siDeepseek, siGooglegemini, siMinimax, siOpencode } from 'simple-icons';

/** simple-icons 的图标对象字段很多，这里只取绘制用的 path。 */
type IconSpec = { path: string };

/**
 * 已知来源的图标。只 import 用到的图标，避免把整个 simple-icons 打进 bundle；
 * 同一个图标可映射多个来源别名（如 minimax 与 minimax-cn）。
 */
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

/**
 * 来源色调 class。与 providerIcons 分开维护：像 zai-coding-cn 没有品牌图标，
 * 但仍需要专属底色，此时会走首字母兜底并保留色调。
 */
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

/**
 * 渲染来源图标。
 *
 * @param provider 来源 id（用于查图标与色调）
 * @param name 来源展示名；用于 title 和无图标时的首字母
 * @param icon 可选自定义图标地址（优先于内置品牌图标）
 * @param size 边长（px），同时写入 CSS 变量供内部 svg/img 自适应
 * @param className 额外 class，调用方用来控制布局（如卡片头像）
 */
export function ProviderIcon({ provider, name, icon, size = 22, className = '' }: { provider: string; name?: string; icon?: string; size?: number; className?: string }) {
  const spec = providerIcons[provider];
  const tone = tones[provider] ?? 'is-neutral';
  // --provider-icon-size 让 CSS 里的内边距/圆角随尺寸缩放。
  const style = { width: size, height: size, '--provider-icon-size': `${size}px` } as React.CSSProperties;

  return <span className={`provider-icon ${tone} ${className}`} style={style} title={name || provider}>
    {icon
      ? <img src={icon} alt="" draggable={false} />
      : spec
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d={spec.path} /></svg>
        : <span className="provider-icon-letter">{(name || provider).slice(0, 1).toUpperCase()}</span>}
  </span>;
}
