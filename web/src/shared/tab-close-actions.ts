import type { MenuAction } from './ActionMenu';

export function tabCloseActions(tabs: readonly { id: string }[], target: string | undefined,
  close: (ids: string[], keepId?: string) => void, fixedFirst?: string): MenuAction[] {
  const ids = tabs.map(tab => tab.id);
  const index = target === undefined ? -1 : ids.indexOf(target);
  const fixed = fixedFirst !== undefined && target === fixedFirst;
  const others = ids.filter(id => id !== target);
  const toRight = ids.slice(index + 1);
  const keepId = fixed ? undefined : target;
  return [
    { label: '关闭此标签页', dividerBefore: true, disabled: index < 0, run: () => close([ids[index]]) },
    { label: '关闭其他标签页', disabled: (!fixed && index < 0) || !others.length, run: () => close(others, keepId) },
    { label: '关闭右侧标签页', disabled: (!fixed && index < 0) || !toRight.length, run: () => close(toRight, keepId) },
    { label: '关闭全部标签页', destructive: true, dividerBefore: true, disabled: !ids.length, run: () => close(ids) },
  ];
}
