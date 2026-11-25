import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Code2, FileText, Folder, FolderInput, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Entry } from './bridge';

type ModalProps = { title: string; onClose: () => void; children: ReactNode; wide?: boolean };
export function Modal({ title, onClose, children, wide }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={wide ? 'notes-dialog is-wide' : 'notes-dialog'} aria-label={title}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2>{title}</h2><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
    {children}
  </dialog>;
}

const KINDS = [
  { id: 'markdown', label: 'Markdown', icon: FileText, extension: '.md' },
  { id: 'html', label: 'HTML', icon: Code2, extension: '.html' },
  { id: 'folder', label: '文件夹', icon: Folder, extension: '' },
] as const;
export type CreateKind = typeof KINDS[number]['id'];

type MutationDialogProps = { busy: boolean; error: string; onClose: () => void };

export function NewEntry({ parent, busy, error, onClose, onCreate }: MutationDialogProps & {
  parent: string;
  onCreate: (name: string, kind: CreateKind) => void;
}) {
  const [kind, setKind] = useState<CreateKind>('markdown');
  const [name, setName] = useState('');
  const extension = KINDS.find(item => item.id === kind)!.extension;
  function create() {
    if (busy || !name.trim()) return;
    const nameWithExtension = kind === 'folder' || /\.(md|markdown|html?)$/i.test(name) ? name.trim() : name.trim() + extension;
    onCreate(nameWithExtension, kind);
  }
  return <Modal title="新建" onClose={onClose}>
      <div className="dialog-content">
        <div className="entry-kinds" role="group" aria-label="文件类型">
          {KINDS.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-pressed={kind === id}
            onClick={() => setKind(id)}><Icon size={16} />{label}</button>)}
        </div>
        <label className="dialog-field">{kind === 'folder' ? '文件夹名' : '标题'}
          <input aria-label={kind === 'folder' ? '文件夹名' : '标题'} autoFocus maxLength={150} value={name}
            placeholder={kind === 'folder' ? '输入文件夹名' : '输入笔记标题'}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) create(); }}
            onChange={event => setName(event.target.value)} />
        </label>
        <small className="dialog-location"><Folder size={14} />{parent || '知识库根目录'}</small>
        {error && <p className="dialog-error" role="alert">{error}</p>}
      </div>
      <footer><button className="secondary" type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary" type="button" disabled={busy || !name.trim()} onClick={create}>创建</button></footer>
  </Modal>;
}

export function ManageEntry({ entry, onClose, onAction }: {
  entry: Entry;
  onClose: () => void;
  onAction: (action: 'new' | 'rename' | 'move' | 'trash') => void;
}) {
  return <Modal title={entry.name} onClose={onClose}>
    <div className="dialog-content action-list">
      {entry.kind === 'folder' && <button type="button" onClick={() => onAction('new')}><Plus size={16} />在此新建</button>}
      {entry.section ? <p className="quiet">此目录是 PARA 分类入口。</p> : <>
        <button type="button" onClick={() => onAction('rename')}><Pencil size={16} />重命名</button>
        <button type="button" onClick={() => onAction('move')}><FolderInput size={16} />移动到</button>
        <button type="button" className="danger-text" onClick={() => onAction('trash')}><Trash2 size={16} />移到废纸篓</button>
      </>}
    </div>
  </Modal>;
}

export function MoveEntry({ entry, folders, rename, busy, error, onClose, onMove }: MutationDialogProps & {
  entry: Entry;
  folders: Entry[];
  rename: boolean;
  onMove: (parent: string, name: string) => void;
}) {
  const [name, setName] = useState(entry.name);
  const [parent, setParent] = useState(entry.parent);
  const [query, setQuery] = useState('');
  const choices = folders.filter(folder => folder.path !== entry.path && !folder.path.startsWith(entry.path + '/')
    && folder.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const disabled = busy || !name.trim() || (name === entry.name && parent === entry.parent);
  function apply() { if (!disabled) onMove(parent, name.trim()); }
  return <Modal title={rename ? '重命名' : '移动到'} onClose={onClose}>
      <div className="dialog-content">
        {rename ? <label className="dialog-field">名称
          <input autoFocus value={name} maxLength={160} onChange={event => setName(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) apply(); }} />
        </label> : <>
          <label className="dialog-field">目标文件夹
            <input autoFocus placeholder="搜索文件夹" value={query} onChange={event => setQuery(event.target.value)} />
          </label>
          <div className="folder-choices" role="group" aria-label="目标目录">
            {!query && <button type="button" aria-pressed={parent === ''} onClick={() => setParent('')}><Folder size={14} />知识库根目录</button>}
            {choices.map(folder => <button key={folder.path} type="button" aria-pressed={parent === folder.path}
              onClick={() => setParent(folder.path)}><Folder size={14} />{folder.path.replaceAll('/', ' / ')}</button>)}
          </div>
        </>}
        {error && <p className="dialog-error" role="alert">{error}</p>}
      </div>
      <footer><button className="secondary" type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary" type="button" disabled={disabled} onClick={apply}>{rename ? '保存名称' : '移动'}</button></footer>
  </Modal>;
}
