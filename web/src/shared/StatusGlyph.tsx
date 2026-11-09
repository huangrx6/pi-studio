/**
 * 状态图形：● 已启用/已连接，○ 已停用/等待，△ 需要处理。
 * 图形只是装饰，语义由旁边的状态文字承担，所以对辅助技术隐藏。
 */
import './status-glyph.css';

export type StatusGlyphState = 'on' | 'off' | 'attention';

const GLYPH: Record<StatusGlyphState, string> = { on: '●', off: '○', attention: '△' };

export function StatusGlyph({ state }: { state: StatusGlyphState }) {
  return <span className={`status-glyph is-${state}`} aria-hidden="true">{GLYPH[state]}</span>;
}
