import { useEffect, useRef, useState } from 'react';
import './stepper.css';

type StepperProps = {
  /** Visible row label; also part of the button accessible names. */
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Suffix shown next to the number, e.g. " px". */
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
};

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 80;

/**
 * 设置页数字步进器：加减按钮支持长按连发，中间数值可点击后直接输入，
 * 回车确认、Esc 取消，边界值会让对应按钮失效。范围由调用方给出。
 */
export function Stepper({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  disabled = false,
  onChange,
}: StepperProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const repeatRef = useRef<{ delay?: number; interval?: number }>({});
  const valueRef = useRef(value);
  valueRef.current = value;

  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)));
  const canDecrease = !disabled && value > min;
  const canIncrease = !disabled && value < max;

  function stopRepeat() {
    window.clearTimeout(repeatRef.current.delay);
    window.clearInterval(repeatRef.current.interval);
    repeatRef.current = {};
  }

  useEffect(() => stopRepeat, []);

  function apply(next: number) {
    const clamped = clamp(next);
    if (clamped !== valueRef.current) onChange(clamped);
  }

  function startRepeat(direction: 1 | -1) {
    stopRepeat();
    apply(valueRef.current + direction * step);
    repeatRef.current.delay = window.setTimeout(() => {
      repeatRef.current.interval = window.setInterval(() => {
        const next = clamp(valueRef.current + direction * step);
        if (next === valueRef.current) {
          stopRepeat();
          return;
        }
        apply(next);
      }, REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  }

  function beginEdit() {
    if (disabled) return;
    setDraft(String(value));
    setEditing(true);
  }

  function commit() {
    const parsed = Number(draft.trim());
    setEditing(false);
    if (Number.isFinite(parsed)) apply(parsed);
  }

  return <div className={`settings-stepper ${disabled ? 'is-disabled' : ''}`}>
    <button
      type="button"
      className="settings-stepper-step"
      aria-label={`减少${label}`}
      disabled={!canDecrease}
      onPointerDown={() => startRepeat(-1)}
      onPointerUp={stopRepeat}
      onPointerLeave={stopRepeat}
      onPointerCancel={stopRepeat}
      onClick={(event) => { if (event.detail === 0) apply(value - step); }}
    >−</button>
    {editing
      ? <input
        className="settings-stepper-input"
        aria-label={`${label}数值`}
        inputMode="numeric"
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); }
          else if (event.key === 'Escape') { event.preventDefault(); setEditing(false); }
        }}
      />
      : <button
        type="button"
        className="settings-stepper-value"
        aria-label={`${label}：${value}${unit}，点击输入`}
        disabled={disabled}
        onClick={beginEdit}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') { event.preventDefault(); apply(value + step); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); apply(value - step); }
        }}
      >{value}{unit}</button>}
    <button
      type="button"
      className="settings-stepper-step"
      aria-label={`增加${label}`}
      disabled={!canIncrease}
      onPointerDown={() => startRepeat(1)}
      onPointerUp={stopRepeat}
      onPointerLeave={stopRepeat}
      onPointerCancel={stopRepeat}
      onClick={(event) => { if (event.detail === 0) apply(value + step); }}
    >+</button>
  </div>;
}
