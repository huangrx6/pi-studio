/**
 * 通用详情弹层：MCP/技能详情、状态面板、快捷键说明等二次信息都用它承载。
 *
 * 行为：通过 createPortal 渲染到 document.body，避免被侧栏或卡片的
 * overflow/层叠上下文裁剪；Esc 关闭；点击弹层外的空白区域关闭。
 *
 * 与 SettingsDialog 的区别：这里用普通 div + role="dialog"，不锁定焦点，
 * 适合只读或轻量内容；表单类弹框请用原生 <dialog> 的 SettingsDialog。
 * 本组件不调用 IPC，内容与关闭动作完全由调用方提供。
 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * @param children 弹层内容
 * @param onClose 关闭回调（Esc 或点击弹层外空白区域时触发）
 * @param className 追加到弹层容器的 class，用于控制尺寸/布局
 */
export function DetailDialog({ children, onClose, className = '' }: { children: ReactNode; onClose: () => void; className?: string }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    // 用 mousedown 判断弹层外空白：避免在弹层内按下、拖到外层松开时被误判为“点击外部”。
    // 外层保持透明，只负责定位与点击关闭，不压暗或模糊后面的设置页面。
    <div className="detail-overlay" role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`detail-dialog ${className}`}>{children}</div>
    </div>,
    document.body,
  );
}
