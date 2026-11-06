import type { ComponentProps, Dispatch, SetStateAction } from 'react';
import { Check, Folder, Image as ImageIcon, Sparkles } from 'lucide-react';
import type { ConcreteThinkingLevel } from '../types/model-types';
import { concreteThinkingLevels, thinkingLabels } from '../types/model-types';
import { emptyCustomModelConfig } from '../features/models/model-settings-types';
import { ProviderEditorFields } from '../features/models/ProviderEditorFields';
import { McpEditorFields } from '../features/mcp/McpEditorFields';
import { Select, type SelectOption } from '../shared/Select';
import { SettingsDialog } from '../shared/SettingsDialog';
import { InfoHint } from '../shared/InfoHint';
import {
  tokenInputAsInteger,
  tokenUnitOptions,
  type TokenField,
  type TokenUnit,
} from '../shared/token-units';
import type { McpTestResult, SettingsEditor, SettingsSnapshot } from './app-types';

type ProviderDraft = ComponentProps<typeof ProviderEditorFields>['draft'];
type McpDraft = ComponentProps<typeof McpEditorFields>['draft'];
type TokenUnits = Record<TokenField, TokenUnit>;
type CustomModelDraft = ReturnType<typeof emptyCustomModelConfig>;

type SettingsEditorDialogProps = {
  editor: SettingsEditor;
  editorError: string | null;
  editorLoading: boolean;
  editorSaving: boolean;
  editorCommitted: boolean;
  editorUnavailable: boolean;
  editorRequestId: number;
  settingsData: SettingsSnapshot | null;
  providerDraft: ProviderDraft;
  setProviderDraft: Dispatch<SetStateAction<ProviderDraft>>;
  apiTypeOptions: SelectOption[];
  customModel: CustomModelDraft;
  setCustomModel: Dispatch<SetStateAction<CustomModelDraft>>;
  tokenUnits: TokenUnits;
  changeTokenUnit: (field: TokenField, unit: TokenUnit) => void;
  toggleModelReasoning: (enabled: boolean) => void;
  toggleModelThinkingLevel: (level: ConcreteThinkingLevel) => void;
  mcpDraft: McpDraft;
  setMcpDraft: Dispatch<SetStateAction<McpDraft>>;
  mcpTesting: boolean;
  mcpTestResult: McpTestResult | null;
  testCurrentMcp: () => Promise<void>;
  resourceScope: 'user' | 'project';
  setResourceScope: (scope: 'user' | 'project') => void;
  skillWorkspace: string;
  setSkillWorkspace: (workspace: string) => void;
  workspaces: Array<{ cwd: string; name: string }>;
  skillWorkspaceOptions: Array<{ value: string; label: string; description: string }>;
  onClose: () => void;
  onRetryLoad: () => void;
  onSubmit: () => void;
};

export function SettingsEditorDialog({
  editor,
  editorError,
  editorLoading,
  editorSaving,
  editorCommitted,
  editorUnavailable,
  editorRequestId,
  settingsData,
  providerDraft,
  setProviderDraft,
  apiTypeOptions,
  customModel,
  setCustomModel,
  tokenUnits,
  changeTokenUnit,
  toggleModelReasoning,
  toggleModelThinkingLevel,
  mcpDraft,
  setMcpDraft,
  mcpTesting,
  mcpTestResult,
  testCurrentMcp,
  resourceScope,
  setResourceScope,
  skillWorkspace,
  setSkillWorkspace,
  workspaces,
  skillWorkspaceOptions,
  onClose,
  onRetryLoad,
  onSubmit,
}: SettingsEditorDialogProps) {
  return <SettingsDialog
    title={editor.kind === 'provider' ? editor.editId ? '编辑模型来源' : '添加模型来源' : editor.kind === 'model' ? editor.editId ? (customModel.origin === 'builtin' ? '调整内置模型' : '编辑模型') : '添加模型' : editor.kind === 'mcp' ? editor.editId ? '编辑 MCP 服务器' : '添加 MCP 服务器' : '添加技能'}
    action={editorCommitted ? '重试刷新' : editor.editId && editorUnavailable ? '重新读取' : editor.kind === 'skill' ? '选择文件夹并添加' : editor.editId ? '保存更改' : '添加'}
    closeLabel={editorCommitted ? '关闭' : '取消'}
    busy={editorSaving}
    busyAction={editorCommitted ? '正在刷新…' : '正在保存…'}
    fieldsDisabled={editorCommitted || Boolean(editor.editId && editorUnavailable)}
    loading={editorLoading}
    unavailable={Boolean(!editor.editId && editorUnavailable)}
    error={editorError}
    onClose={onClose}
    onSubmit={() => { if (editor.editId && editorUnavailable) onRetryLoad(); else onSubmit(); }}
    showBackdrop={false}
  >
    {editor.kind === 'provider' && <ProviderEditorFields
      key={editorRequestId}
      draft={providerDraft}
      setDraft={setProviderDraft}
      editing={Boolean(editor.editId)}
      apiTypeOptions={apiTypeOptions}
      settingsBusy={editorSaving || editorCommitted || editorUnavailable}
    />}
    {editor.kind === 'model' && <div className="settings-form-grid model-editor-form">
      <div className="settings-field field-wide">
        <span className="settings-field-heading"><span>模型来源</span>{customModel.origin === 'builtin' && <InfoHint label="这是 Pi 内置模型。保存会为当前来源建立参数覆盖，不会替换同一来源的其他内置模型。" />}</span>
        <Select label="模型来源" disabled value={customModel.providerId} onChange={() => {}} options={(settingsData?.providers ?? []).filter((provider) => provider.id === customModel.providerId).map((provider) => ({ value: provider.id, label: `${provider.name} · ${provider.id}` }))} />
      </div>
      <label>模型 ID<input autoFocus required disabled={Boolean(editor.editId)} value={customModel.modelId} onChange={(event) => setCustomModel({ ...customModel, modelId: event.target.value })} placeholder="model-id" /></label>
      <label>显示名称<input value={customModel.name} onChange={(event) => setCustomModel({ ...customModel, name: event.target.value })} placeholder="可选，默认使用模型 ID" /></label>
      <div className="model-token-field">
        <label htmlFor="model-context-window">上下文长度</label>
        <div className="model-token-input">
          <input
            id="model-context-window"
            aria-label="上下文长度"
            type="number"
            inputMode="decimal"
            min={tokenUnits.contextWindow === 'tokens' ? '1' : '0.000001'}
            step={tokenUnits.contextWindow === 'tokens' ? '1' : 'any'}
            value={customModel.contextWindow}
            onChange={(event) => setCustomModel({ ...customModel, contextWindow: event.target.value })}
            placeholder="接口与模型目录未提供"
          />
          <Select
            label="上下文长度单位"
            value={tokenUnits.contextWindow}
            onChange={(value) => changeTokenUnit('contextWindow', value as TokenUnit)}
            options={tokenUnitOptions}
          />
        </div>
        {tokenInputAsInteger(String(customModel.contextWindow), tokenUnits.contextWindow)
          ? <small className="model-token-exact">{tokenInputAsInteger(String(customModel.contextWindow), tokenUnits.contextWindow)?.toLocaleString()} tokens</small>
          : null}
      </div>
      <div className="model-token-field">
        <label htmlFor="model-max-tokens">最大输出</label>
        <div className="model-token-input">
          <input
            id="model-max-tokens"
            aria-label="最大输出"
            type="number"
            inputMode="decimal"
            min={tokenUnits.maxTokens === 'tokens' ? '1' : '0.000001'}
            step={tokenUnits.maxTokens === 'tokens' ? '1' : 'any'}
            value={customModel.maxTokens}
            onChange={(event) => setCustomModel({ ...customModel, maxTokens: event.target.value })}
            placeholder="接口与模型目录未提供"
          />
          <Select
            label="最大输出单位"
            value={tokenUnits.maxTokens}
            onChange={(value) => changeTokenUnit('maxTokens', value as TokenUnit)}
            options={tokenUnitOptions}
          />
        </div>
        {tokenInputAsInteger(String(customModel.maxTokens), tokenUnits.maxTokens)
          ? <small className="model-token-exact">{tokenInputAsInteger(String(customModel.maxTokens), tokenUnits.maxTokens)?.toLocaleString()} tokens</small>
          : null}
      </div>
      <div className="model-capability-options field-wide" role="group" aria-label="模型能力">
        <label className={customModel.supportsImages ? 'is-selected' : ''}><input type="checkbox" checked={customModel.supportsImages} onChange={(event) => setCustomModel({ ...customModel, supportsImages: event.target.checked })} /><span><strong>图片输入</strong></span><ImageIcon /></label>
        <label className={customModel.reasoning ? 'is-selected' : ''}><input type="checkbox" checked={customModel.reasoning} onChange={(event) => toggleModelReasoning(event.target.checked)} /><span><strong>推理模型</strong></span><Sparkles /></label>
      </div>
      {customModel.reasoning && <div className="model-thinking-levels field-wide">
        <div className="model-thinking-levels-head">
          <div><strong>可用推理等级 <InfoHint label="只勾选模型实际接受的强度；请求参数由对应的 Pi Provider 适配。模型目录没有声明时会尝试 models.dev、Pi 官方目录，最后回退到 Off–High。" /></strong></div>
          <small>{customModel.thinkingLevels.length} / {concreteThinkingLevels.length}</small>
        </div>
        <div className="model-thinking-level-options" role="group" aria-label="可用推理等级">
          {concreteThinkingLevels.map((level) => {
            const selected = customModel.thinkingLevels.includes(level);
            return <button
              type="button"
              key={level}
              className={selected ? 'is-selected' : ''}
              role="checkbox"
              aria-checked={selected}
              onClick={() => toggleModelThinkingLevel(level)}
            >
              <span>{selected && <Check aria-hidden="true" />}</span>
              {thinkingLabels[level]}
            </button>;
          })}
        </div>
      </div>}
    </div>}
    {editor.kind === 'mcp' && <McpEditorFields
      key={editorRequestId}
      draft={mcpDraft}
      setDraft={setMcpDraft}
      editing={Boolean(editor.editId)}
      mcpTesting={mcpTesting}
      settingsBusy={editorSaving || editorCommitted || editorUnavailable}
      testCurrentMcp={testCurrentMcp}
      testResult={mcpTestResult}
    />}
    {editor.kind === 'skill' && <div className="resource-import">
      <div className="field-label-row"><span className="field-label">生效范围</span><InfoHint label="全局技能写入 Studio 应用数据目录；项目技能写入所选工作区的 .pi-studio/skills。待导入目录必须直接包含 SKILL.md。" /></div>
      <div className="scope-options">
        <label className={resourceScope === 'user' ? 'is-selected' : ''}>
          <input type="radio" name="scope" checked={resourceScope === 'user'} onChange={() => setResourceScope('user')} />
          <div><strong>全局</strong></div>
        </label>
        <label className={resourceScope === 'project' ? 'is-selected' : ''}>
          <input
            type="radio"
            name="scope"
            disabled={workspaces.length === 0}
            checked={resourceScope === 'project'}
            onChange={() => {
              setResourceScope('project');
              if (!skillWorkspace) setSkillWorkspace(workspaces[0]?.cwd || '');
            }}
          />
          <div><strong>项目</strong></div>
        </label>
      </div>
      {resourceScope === 'project' && <div className="skill-workspace-picker">
        <label>目标工作区</label>
        <Select
          label="项目技能工作区"
          value={skillWorkspace}
          options={skillWorkspaceOptions}
          placeholder={workspaces.length > 0 ? '选择工作区' : '还没有工作区'}
          disabled={workspaces.length === 0}
          leadingIcon={<Folder />}
          onChange={setSkillWorkspace}
        />
      </div>}
    </div>}
  </SettingsDialog>;
}
