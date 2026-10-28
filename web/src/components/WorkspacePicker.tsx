import { FolderOpen, X } from 'lucide-react';
import { Select } from './Select';

export function WorkspacePicker({ value, workspaces, onChange, onBrowse }: {
  value: string;
  workspaces: Array<{ cwd: string; name: string }>;
  onChange: (cwd: string) => void;
  onBrowse: () => void;
}) {
  const options = workspaces.map(item => ({ value: item.cwd, label: item.name, description: item.cwd }));
  if (value && !workspaces.some(item => item.cwd === value)) options.unshift({ value, label: value.split('/').pop() || value, description: value });
  options.push({ value: '__browse__', label: '打开其他文件夹…', description: '选择本机文件夹作为工作区' });
  return <div className="workspace-choice-row">
    <div className={`workspace-choice ${value ? 'has-selection' : ''}`} title={value || '选择本次对话的工作区'}>
      <FolderOpen aria-hidden="true" />
      <Select label="新对话工作区" value={value} placeholder="选择工作区" options={options} menuClassName="workspace-choice-menu" onChange={next => next === '__browse__' ? onBrowse() : onChange(next)} />
      {value && <button type="button" className="workspace-choice-clear" aria-label="取消选择工作区" title="取消选择工作区" onClick={() => onChange('')}><X /></button>}
    </div>
  </div>;
}
