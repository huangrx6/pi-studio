/**
 * 新对话的工作区选择行。
 *
 * 由三部分组成：文件夹图标 + 复用的 Select 下拉 + 清除按钮。
 *
 * 下拉选项来自两类数据：
 * - 已打开的工作区列表；
 * - 一个 `__browse__` 哨兵项，选中后触发系统目录选择器。
 * 如果当前 value 不在列表里（例如刚通过「打开其他文件夹」选了一个新目录），
 * 会临时插入一个选项，避免受控 Select 显示为空。
 *
 * 本组件不直接调用 IPC：onBrowse 由 App 实现（内部使用
 * `window.piApi.chooseWorkspace`），选中结果通过 onChange 回传。
 */
import { FolderOpen, X } from 'lucide-react';
import { Select } from './Select';

/**
 * @param value 当前选中的工作区路径（空字符串表示未选）
 * @param workspaces 已打开的工作区
 * @param onChange 选择已有工作区或清除（空字符串）时回调
 * @param onBrowse 选择「打开其他文件夹…」时回调，由 App 拉起目录选择器
 */
export function WorkspacePicker({ value, workspaces, onChange, onBrowse }: {
  value: string;
  workspaces: Array<{ cwd: string; name: string }>;
  onChange: (cwd: string) => void;
  onBrowse: () => void;
}) {
  const options = workspaces.map(item => ({ value: item.cwd, label: item.name, description: item.cwd }));
  // 当前值不在列表时补一个临时选项，否则 Select 只能显示 placeholder，
  // 用户会误以为选择没有生效。
  if (value && !workspaces.some(item => item.cwd === value)) options.unshift({ value, label: value.split('/').pop() || value, description: value });
  options.push({ value: '__browse__', label: '打开其他文件夹…', description: '选择本机文件夹作为工作区' });
  return <div className="workspace-choice-row">
    <div className={`workspace-choice ${value ? 'has-selection' : ''}`} title={value || '选择本次对话的工作区'}>
      <FolderOpen aria-hidden="true" />
      {/* Select 只能返回值，所以「浏览文件夹」复用同一个菜单，用哨兵值分流。 */}
      <Select label="新对话工作区" value={value} placeholder="选择工作区" options={options} menuClassName="workspace-choice-menu" onChange={next => next === '__browse__' ? onBrowse() : onChange(next)} />
      {/* 只有已有选择时才显示清除按钮，避免空态下出现无意义的叉号。 */}
      {value && <button type="button" className="workspace-choice-clear" aria-label="取消选择工作区" title="取消选择工作区" onClick={() => onChange('')}><X /></button>}
    </div>
  </div>;
}
