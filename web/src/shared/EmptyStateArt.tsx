/**
 * 空状态的单色几何线稿：不依赖设计资源，也不用彩色或渐变。
 * 纯装饰，标题与说明文字已经表达了状态。
 */
export function EmptyStateArt({ size = 56 }: { size?: number }) {
  return <svg
    className="empty-state-art"
    width={size}
    height={size}
    viewBox="0 0 56 56"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.25"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="6.5" y="12.5" width="43" height="31" rx="4" />
    <path d="M6.5 20.5h43" />
    <circle cx="11.5" cy="16.5" r="1" fill="currentColor" stroke="none" />
    <path d="M17 27h13M17 33h8" />
    <path d="M36 32.5l2.6 2.6L44 30" />
  </svg>;
}
