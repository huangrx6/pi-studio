import { useEffect, useRef, useState } from 'react';

/**
 * 即时生效的设置需要一句确认：改动落盘后短暂显示「✓ 已保存」。
 * 只在偏好真正变化时出现，首次挂载不打扰；1.2s 后自动消失。
 */
export function SettingsSavedFlash({ signal }: { signal: unknown }) {
  const [visible, setVisible] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return undefined;
    }
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 1200);
    return () => window.clearTimeout(timer);
  }, [signal]);

  return <div className={`settings-saved-flash ${visible ? 'is-visible' : ''}`} role="status" aria-live="polite">
    <span aria-hidden="true">✓</span>{visible ? '已保存' : ''}
  </div>;
}
