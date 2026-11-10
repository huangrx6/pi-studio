import { lazy, Suspense, useState, type Dispatch, type SetStateAction, type MutableRefObject } from 'react';
import { LoaderCircle, Plus } from 'lucide-react';
import type { ModelComparisonContext } from '../../shell/app-types';
import type { ModelSelection } from '../../types/model-types';
import type { StoredModelComparisonMap } from '../../shared/stored-ui-state';
import { Select } from '../../shared/Select';
import './model-comparison.css';

const ModelComparisonPanel = lazy(async () => {
  const module = await import('./ModelComparisonPanel');
  return { default: module.ModelComparisonPanel };
});

export function ComparisonWorkbench({ context, starting, onStartingChange, startPending, onContextChange, history, setHistory, workspace, modelSelection, onOpenSettings, onAdopt }: {
  context: ModelComparisonContext | null;
  starting: boolean;
  onStartingChange: (value: boolean) => void;
  startPending: MutableRefObject<boolean>;
  onContextChange: Dispatch<SetStateAction<ModelComparisonContext | null>>;
  history: StoredModelComparisonMap;
  setHistory: Dispatch<SetStateAction<StoredModelComparisonMap>>;
  workspace: string;
  modelSelection: ModelSelection;
  onOpenSettings: () => void;
  onAdopt: (id: string) => void;
}) {
  const [generation, setGeneration] = useState(0);
  const saved = context?.parentId ? history[context.parentId] : undefined;
  const cwd = context?.cwd || workspace;
  const newEvaluation = () => {
    onContextChange({ parentId: '', cwd: workspace, prompt: '', mentions: [], attachments: [], images: [], initialModelRef: modelSelection.modelRef, initialThinkingLevel: modelSelection.thinkingLevel });
    setGeneration(value => value + 1);
  };
  return <div className="comparison-workbench">
    <header className="comparison-workbench-header">
      <strong>模型评估</strong>
      <button type="button" className="text-button" disabled={starting} onClick={newEvaluation}><Plus size={14} />新评估</button>
    </header>
    <div className="comparison-workbench-history">
      <Select disabled={starting} label="评估历史" value={saved?.result.parentId || ''} options={[
        { value: '', label: '新评估' },
        ...Object.values(history).sort((a, b) => b.result.createdAt - a.result.createdAt).map(entry => ({ value: entry.result.parentId, label: entry.result.prompt, description: new Date(entry.result.createdAt).toLocaleString('zh-CN') })),
      ]} onChange={id => {
        const entry = history[id];
        if (!entry) { newEvaluation(); return; }
        onContextChange({ parentId: id, cwd: entry.cwd, prompt: entry.result.prompt, mentions: [], attachments: [], images: [], initialModelRef: entry.initialModelRef, initialThinkingLevel: entry.initialThinkingLevel });
        setGeneration(value => value + 1);
      }} />
      <small title={cwd}>工作区 · {cwd || '请先选择工作区'}</small>
    </div>
    <Suspense fallback={<div className="panel-route-loading"><LoaderCircle className="spin" /></div>}>
      <ModelComparisonPanel
        key={generation}
        parentId={context?.parentId || ''}
        cwd={cwd}
        initialPrompt={context?.prompt || ''}
        initialComparison={saved?.result}
        initialModelRef={context?.initialModelRef || modelSelection.modelRef}
        initialThinkingLevel={context?.initialThinkingLevel || modelSelection.thinkingLevel}
        mentions={context?.mentions || []} attachments={context?.attachments || []} images={context?.images || []}
        onStartingChange={onStartingChange}
        startBusy={starting}
        startPending={startPending}
        onPromptChange={prompt => onContextChange(current => current ? { ...current, prompt } : current)}
        onParentCreated={parentId => onContextChange(current => current ? { ...current, parentId, cwd } : current)}
        onStarted={result => {
          setHistory(current => ({ ...current, [result.parentId]: { result, cwd, initialModelRef: context?.initialModelRef || modelSelection.modelRef, initialThinkingLevel: context?.initialThinkingLevel || modelSelection.thinkingLevel } }));
          onContextChange(current => current ? { ...current, parentId: result.parentId, prompt: result.prompt } : current);
        }}
        onAdopt={onAdopt} onManageModels={onOpenSettings}
      />
    </Suspense>
  </div>;
}
