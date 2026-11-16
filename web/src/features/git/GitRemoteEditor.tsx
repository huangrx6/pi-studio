import { useState } from 'react';
import { Select } from '../../shared/Select';
import { SettingsDialog } from '../../shared/SettingsDialog';
import type { GitAction, GitRemoteInfo } from '../../types/git-types';

export function GitRemoteEditor({ info, busy, disabled, error, execute, close, choose }: {
  info?: GitRemoteInfo; busy: boolean; disabled: boolean; error: string; execute: (action: GitAction) => Promise<boolean>;
  close: () => void; choose: (name: string) => void;
}) {
  const [mode, setMode] = useState(info ? 'fetch' : 'add');
  const [name, setName] = useState(info ? '' : 'origin');
  const [url, setUrl] = useState(info?.editableFetch || '');
  const [inherit, setInherit] = useState(!info?.explicitPush);
  const [submitted, setSubmitted] = useState(false);
  const modes = [{ value: 'fetch', label: '修改获取地址' }, { value: 'push', label: '修改推送地址' },
    { value: 'rename', label: '重命名远程' }, { value: 'add', label: '添加远程' }, { value: 'remove', label: '移除远程' }];
  const needsName = mode === 'add' || mode === 'rename';
  const needsAddress = mode === 'add' || mode === 'fetch' || (mode === 'push' && !inherit);
  const original = mode === 'push' ? info?.pushUrls : info?.fetchUrls;
  const changed = mode === 'fetch' ? url.trim() !== info?.editableFetch
    : mode === 'push' ? (inherit ? info?.explicitPush : !info?.explicitPush || url.trim() !== info.editablePush) : true;
  const canSave = changed && (!needsName || !!name.trim()) && (!needsAddress || !!url.trim());
  async function save() {
    let action: GitAction;
    if (mode === 'add') action = { kind: 'remoteAdd', name: name.trim(), url: url.trim() };
    else if (!info) return;
    else if (mode === 'rename') action = { kind: 'remoteRename', remote: info.name, name: name.trim(), version: info.version };
    else if (mode === 'remove') action = { kind: 'remoteRemove', remote: info.name, version: info.version };
    else action = { kind: 'remoteEdit', remote: info.name, field: mode === 'push' ? 'push' : 'fetch', url: mode === 'push' && inherit ? '' : url.trim(), version: info.version };
    setSubmitted(true);
    if (await execute(action)) { if (needsName) choose(name.trim()); close(); }
  }
  return <SettingsDialog title={info ? '管理远程 · ' + info.name : '添加远程仓库'}
    action={mode === 'remove' ? '确认移除' : mode === 'add' ? '添加远程' : '保存修改'} loading={false} busy={busy}
    unavailable={!canSave || disabled} error={submitted ? error : null} onSubmit={() => void save()} onClose={close}>
    <div className="git-remote-form">
      {info && <label>操作<Select label="远程操作" options={modes} value={mode} onChange={value => {
        setMode(value); setName(''); setSubmitted(false); setInherit(!info.explicitPush);
        setUrl(value === 'fetch' ? info.editableFetch : value === 'push' ? info.editablePush : '');
      }} /></label>}
      {needsName && <label>远程名称<input required value={name} placeholder="origin" maxLength={200} onChange={e => setName(e.target.value)} /></label>}
      {info && (mode === 'fetch' || mode === 'push') && <div><small>当前{mode === 'push' ? '推送' : '获取'}地址</small>{original?.map((s, i) => <code key={i}>{s}</code>)}</div>}
      {mode === 'push' && <label className="git-inherit-url"><input type="checkbox" checked={inherit} onChange={e => setInherit(e.target.checked)} />使用获取地址推送</label>}
      {needsAddress && <label>{mode === 'push' ? '新的推送地址' : mode === 'fetch' ? '新的获取地址' : '仓库地址'}
        <input value={url} spellCheck={false} autoComplete="off" placeholder="https://host/owner/repo.git"
          onChange={e => setUrl(e.target.value)} /></label>}
      {original && original.length > 1 && (mode === 'fetch' || mode === 'push') && <p>保存后会替换上方列出的全部地址。</p>}
      {mode === 'remove' && <p>将移除本地配置中的 <strong>{info?.name}</strong> 和它的远程跟踪引用。以后可用仓库地址重新添加。</p>}
    </div>
  </SettingsDialog>;
}
