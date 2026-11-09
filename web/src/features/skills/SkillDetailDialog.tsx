import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Folder, LoaderCircle, RotateCw, X } from 'lucide-react';
import { DetailDialog } from '../../shared/DetailDialog';
import { DeferredFilePreview } from '../../shared/DeferredFilePreview';
import { FileKindIcon } from '../../shared/FileKindIcon';
import { formatFileSize } from '../../shared/filesize';
import { StatusGlyph } from '../../shared/StatusGlyph';
import { installedSkillStatus } from './installed-skill-status';
import { createSkillDetailResource, emptySkillDetailState } from './skill-detail-resource';
import './skill-detail.css';

type Skill = Awaited<ReturnType<Window['piApi']['settings']>>['skills'][number];

export function SkillDetailDialog({ skill, busy, error, refreshing = false, onRefresh, onClose, onTrust }: {
  skill: Skill;
  busy: boolean;
  error: string | null;
  refreshing?: boolean;
  onRefresh?: () => void;
  onClose: () => void;
  onTrust: (skill: Skill, trusted: boolean) => void;
}) {
  const baseDir = skill.baseDir || skill.path.slice(0, skill.path.lastIndexOf('/')) || '/';
  const [state, setState] = useState(emptySkillDetailState);
  const resource = useRef<ReturnType<typeof createSkillDetailResource> | null>(null);
  useEffect(() => {
    const next = createSkillDetailResource({ baseDir, api: window.piApi, onChange: setState });
    resource.current = next;
    void next.loadDirectory('');
    return () => { next.dispose(); if (resource.current === next) resource.current = null; };
  }, [baseDir]);
  const status = installedSkillStatus(skill);
  return <DetailDialog className="skill-detail-dialog" onClose={onClose}>
    <header className="detail-header">
      <div className="detail-heading"><div>
        <h2>{skill.name}</h2>
        {skill.description && <p>{skill.description}</p>}
        <small className={`resource-status ${skill.available ? 'is-on' : ''}`}><StatusGlyph state={skill.available ? 'on' : 'attention'} />{status.label}</small>
      </div></div>
      <button type="button" className="icon-button" aria-label="关闭技能详情" onClick={onClose}><X /></button>
    </header>
    <details className="skill-detail-location"><summary>文件位置</summary><code>{skill.path}</code></details>
    {error && <div className="detail-error" role="alert"><p>{error}</p>{onRefresh && <button type="button" className="settings-outline" disabled={refreshing} onClick={onRefresh}>{refreshing ? '正在刷新…' : '刷新技能状态'}</button>}</div>}
    <div className="skill-detail-body">
      <aside className="skill-file-tree" aria-label="技能目录">
        <div className="skill-tree-toolbar">
          <button type="button" className="icon-button" aria-label="返回上级目录" disabled={!state.treePath || state.treeBusy}
            onClick={() => void resource.current?.loadDirectory(state.treePath.split('/').slice(0, -1).join('/'))}><ChevronLeft /></button>
          <span title={state.treePath || '/'}>{state.treePath ? `/${state.treePath}` : '/'}</span>
          <button type="button" className="icon-button" aria-label="刷新技能文件" disabled={state.treeBusy}
            onClick={() => void resource.current?.retryDirectory()}><RotateCw /></button>
        </div>
        <div className="skill-tree-list">
          {state.treeBusy ? <div className="skill-tree-empty" role="status"><LoaderCircle className="spin" aria-hidden="true" />正在读取目录</div>
            : state.treeError ? <div className="skill-detail-read-error" role="alert"><p>{state.treeError}</p><button type="button" className="text-button" onClick={() => void resource.current?.retryDirectory()}>重试读取技能目录</button></div>
            : state.entries.length ? state.entries.map(entry => <button type="button" key={entry.path}
              className={`file-row ${entry.type === 'directory' ? 'is-directory' : ''} ${state.filePath === entry.path ? 'is-active' : ''}`}
              aria-current={state.filePath === entry.path ? 'page' : undefined} title={entry.name}
              onClick={() => entry.type === 'directory' ? void resource.current?.loadDirectory(entry.path) : void resource.current?.openFile(entry.path)}>
              {entry.type === 'directory' ? <Folder /> : <FileKindIcon path={entry.path} className="file-kind-icon" />}
              <span>{entry.name}</span>{entry.type === 'file' && <small>{formatFileSize(entry.size)}</small>}{entry.type === 'directory' && <ChevronRight />}
            </button>) : <div className="skill-tree-empty">目录为空</div>}
        </div>
      </aside>
      <section className="skill-file-preview" aria-label="技能文件预览">
        {state.externalError && <div className="skill-detail-read-error" role="alert">{state.externalError}</div>}
        {state.fileError ? <div className="skill-detail-read-error" role="alert"><p>{state.fileError}</p><button type="button" className="text-button" onClick={() => void resource.current?.retryFile()}>重试读取技能文件</button></div>
          : <DeferredFilePreview file={state.file} loading={state.fileBusy} emptyTitle="选择一个文件" onOpenExternal={file => void resource.current?.openExternal(file)} />}
      </section>
    </div>
    {skill.scope === 'project' && <footer className="detail-footer"><span />
      <button type="button" className="settings-outline" disabled={busy} onClick={() => onTrust(skill, !skill.trusted)}>
        {skill.trusted ? '撤销信任' : skill.trustChanged ? '重新信任' : '信任技能'}
      </button>
    </footer>}
  </DetailDialog>;
}
