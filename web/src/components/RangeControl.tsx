import type { CSSProperties } from 'react';

type RangeControlProps = {
  id: string;
  label: string;
  description: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
};

/**
 * Studio 统一滑杆。进度条与滑块都由设计令牌绘制，浏览器原生 range 外观只负责
 * 命中区域和键盘语义，避免各设置页出现不同平台的轨道与滑块。
 */
export function RangeControl({
  id,
  label,
  description,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '%',
  disabled = false,
  onChange,
}: RangeControlProps) {
  const span = Math.max(1, max - min);
  const progress = Math.min(100, Math.max(0, ((value - min) / span) * 100));
  const style = {
    '--range-progress': `${progress}%`,
  } as CSSProperties;

  return (
    <label className={`settings-range-control ${disabled ? 'is-disabled' : ''}`} htmlFor={id}>
      <span className="settings-range-copy">
        <span>
          <strong>{label}</strong>
          <small id={`${id}-description`}>{description}</small>
        </span>
        <output htmlFor={id}>{value}{unit}</output>
      </span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={`${id}-description`}
        aria-valuetext={`${value}${unit}`}
        style={style}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
