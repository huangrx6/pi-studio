import { useCallback, useEffect, useRef, useState } from 'react';
import { LoadingState } from '../../shared/LoadingState';
import { errorText } from '../../shared/error-text';
import type { StoryboardSummary, StoryboardWork } from '../../types/storyboard-types';
import { settleStoryboardDrafts } from './storyboard-drafts';
import { StoryboardProject } from './StoryboardProject';
import { StoryboardHeader, StoryboardStart } from './StoryboardLibrary';
import './styles/workbench.css';

export default function StoryboardWorkbench({ workspace, onChooseWorkspace, onConfigureModels, settingsOpen }: {
  workspace: string; onChooseWorkspace: () => void; onConfigureModels: () => void; settingsOpen: boolean;
}) {
  const [works, setWorks] = useState<StoryboardSummary[]>([]);
  const [current, setCurrent] = useState<StoryboardWork | null>(null);
  const [busy, setBusy] = useState(Boolean(workspace));
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const action = useRef(false);
  const selectionKey = `studio.storyboard.selection:${workspace}`;
  const updateWork = useCallback((next: StoryboardWork) => {
    setCurrent(shown => shown?.id === next.id && shown.revision <= next.revision ? next : shown);
  }, []);

  useEffect(() => {
    if (!workspace) return;
    let closed = false;
    async function restore() {
      setBusy(true);
      setError('');
      await settleStoryboardDrafts(workspace);
      const rows = await window.piApi.storyboardList(workspace);
      const remembered = sessionStorage.getItem(selectionKey);
      const selected = rows.find(row => row.id === remembered) ?? rows[0];
      const work = selected ? await window.piApi.storyboardRead(workspace, selected.id) : null;
      if (!closed) { setWorks(rows); setCurrent(work); }
    }
    void restore().catch(cause => { if (!closed) setError(errorText(cause)); })
      .finally(() => { if (!closed) setBusy(false); });
    return () => { closed = true; };
  }, [workspace, selectionKey, reload]);

  async function openWork(id?: string, example?: 'web-sources') {
    if (action.current || busy || (id !== undefined && id === current?.id)) return;
    action.current = true;
    setBusy(true);
    setError('');
    try {
      await settleStoryboardDrafts(workspace, current?.id);
      const work = id ? await window.piApi.storyboardRead(workspace, id) : await window.piApi.storyboardCreate(workspace, example);
      if (!id) setWorks(list => [{ id: work.id, title: work.document.title, updatedAt: work.updatedAt }, ...list]);
      sessionStorage.setItem(selectionKey, work.id);
      setCurrent(work);
    } catch (cause) { setError(errorText(cause)); }
    finally { action.current = false; setBusy(false); }
  }

  return <section className="story-workbench" aria-label="视频分镜工作台">
    <div className="story-page">
      <StoryboardHeader works={works} currentId={current?.id} busy={busy} select={id => void openWork(id)}
        create={example => void openWork(undefined, example)} />
      {error && <div className="story-error" role="alert">{error} <button className="secondary-button" onClick={() => setReload(value => value + 1)}>重新载入</button></div>}
      {current ? <fieldset disabled={busy} aria-label="当前作品" className="story-work-controls"><StoryboardProject key={current.id} work={current} workspace={workspace}
        onWork={updateWork}
        onConfigureModels={onConfigureModels} settingsOpen={settingsOpen}
        onRename={title => setWorks(list => list.map(work => work.id === current.id ? { ...work, title } : work))} /></fieldset>
        : busy ? <LoadingState variant="panel">正在读取作品…</LoadingState>
        : !error && <StoryboardStart workspace={workspace} chooseWorkspace={onChooseWorkspace}
          create={example => void openWork(undefined, example)} />}
    </div>
  </section>;
}
