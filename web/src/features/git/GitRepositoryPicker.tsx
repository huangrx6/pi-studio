import { FolderGit2 } from 'lucide-react';
import { Select } from '../../shared/Select';
import { useGitRepositories } from './useWorkspaceRepositories';

export function GitRepositoryPicker({ label = '选择项目仓库' }: { label?: string }) {
  const { repositories, selected, select } = useGitRepositories();
  if (!selected || (repositories.length === 1 && selected.id === '.')) return null;
  return <Select className="git-repository-picker" label={label} title={selected.id === '.' ? selected.name : selected.id} leadingIcon={<FolderGit2 />}
    value={selected.id} onChange={select}
    options={repositories.map(repo => ({ value: repo.id, label: repo.id === '.' ? repo.name : repo.id,
      description: repo.id === '.' ? '工作区所在仓库' : undefined }))} />;
}
