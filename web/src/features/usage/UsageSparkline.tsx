import type { UsageAnalyticsSnapshot } from '../../types/usage-types';

function compact(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value || 0);
}

/**
 * 近 30 天每日 Token 趋势：40px 高、单色、无坐标轴。
 * 细节数值由热力图承担，这里只表达走向；空数据不输出任何图形。
 */
export function UsageSparkline({ daily }: { daily: UsageAnalyticsSnapshot['daily'] }) {
  const points = daily.slice(-30);
  if (points.length < 2) return null;
  const max = Math.max(...points.map(item => item.totalTokens), 1);
  const step = 100 / (points.length - 1);
  const coords = points.map((item, index) => `${(index * step).toFixed(2)},${(38 - (item.totalTokens / max) * 34).toFixed(2)}`);
  return <svg
    className="usage-sparkline"
    viewBox="0 0 100 40"
    preserveAspectRatio="none"
    role="img"
    aria-label={`近 ${points.length} 天每日 Token 趋势，峰值 ${compact(max)}`}
  >
    <polyline
      points={coords.join(' ')}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  </svg>;
}
