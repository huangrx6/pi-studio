import { useEffect, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Select } from '../../shared/Select';
import { errorText } from '../../shared/error-text';
import type { ModelCatalog } from '../../types/model-types';

export function useStoryboardTextModel(workspace: string, modelRef: string, settingsOpen = false) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    if (settingsOpen) return;
    setError('');
    setCatalog(null);
    void window.piApi.models(workspace).then(result => {
      if (active) setCatalog(result);
    }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [workspace, settingsOpen, attempt]);
  const models = catalog?.models ?? [];
  const selected = models.find(model => model.id === modelRef)
    ?? models.find(model => model.id === catalog?.defaultSelection.modelRef) ?? models[0];
  return { models, selected, error, loading: !catalog && !error, reload: () => setAttempt(n => n + 1) };
}

export function StoryboardTextModel({ state, label, onModel, onConfigure, disabled }: {
  state: ReturnType<typeof useStoryboardTextModel>; label: string;
  onModel: (id: string) => void; onConfigure: () => void; disabled?: boolean;
}) {
  return <div className="story-field"><span>{label}</span>
    {state.error ? <div><p className="story-error" role="alert">{state.error}</p>
      <button type="button" className="secondary-button" onClick={state.reload}>重新读取模型</button></div>
      : state.loading ? <small role="status">正在读取模型…</small>
      : state.selected ? <Select label={label} value={state.selected.id} disabled={disabled}
        options={state.models.map(model => ({ value: model.id, label: model.name, description: model.providerName }))}
        onChange={onModel} />
      : <div className="story-draft-empty"><small>还没有可用的文本模型。</small><button className="secondary-button" type="button"
        onClick={onConfigure}><Settings2 />配置模型</button></div>}
  </div>;
}
