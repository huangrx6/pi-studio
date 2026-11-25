import { useId, useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { Accordion } from '../../shared/Accordion';
import { Select, type SelectOption } from '../../shared/Select';
import { useSettingsToast } from '../../shared/SettingsToast';
import { errorText } from '../../shared/error-text';
import { concreteThinkingLevels } from '../../types/model-types';
import type { SubagentConfig, SubagentRuntimeOverrides, SubagentThinking } from '../../types/subagent-types';
import toolDescriptions from '../../../../assets/settings/builtin-tool-descriptions.zh-CN.json';

type Access = SubagentRuntimeOverrides['allowedTools'];
type Props = {
  defaults: SubagentConfig;
  supportedThinking?: SubagentThinking[];
  overrides: SubagentRuntimeOverrides;
  onChange: <K extends keyof SubagentRuntimeOverrides>(key: K, value: SubagentRuntimeOverrides[K]) => void;
};
const inherit = 'inherit';
const options = (entries: Record<string, string>): SelectOption[] => Object.entries(entries).map(([value, label]) => ({ value, label }));
const accessLabels = { 'read-only': '只读文件', 'read-write': '读写文件', custom: '自选工具', inherit: '继承运行默认值', parent: '跟随父智能体工具' };
export function usesFileTools(access: Access) { return access === 'read-only' || access === 'read-write'; }
export function roleAccessLabel(access: Access) {
  return accessLabels[Array.isArray(access) ? 'custom' : access ?? 'inherit'];
}

export function RoleToolAccess({ access, common, tools, onChange }: {
  access: Access; common: string[]; tools: string[]; onChange: (next: Access) => void;
}) {
  const [filter, setFilter] = useState('');
  const mode = Array.isArray(access) ? 'custom' : access ?? inherit;
  const descriptions: Record<string, string> = toolDescriptions;
  const choices = Array.isArray(access) ? [...new Set([...tools, ...access])].filter(name =>
    (name + ' ' + (descriptions[name] || '')).toLowerCase().includes(filter.trim().toLowerCase())) : [];
  const help = {
    inherit: common.length ? '当前运行默认值限定了 ' + common.length + ' 个工具。' : '跟随父智能体当前可用的工具。',
    parent: '直接使用父智能体当前可用的本地工具。MCP 服务可在下方单独选择。',
    'read-only': '可以读取文件、列目录和搜索内容。终端、MCP 和其他扩展工具均关闭。',
    'read-write': '可以读取、搜索、新建和编辑文件。终端、MCP 和其他扩展工具均关闭。',
    custom: '勾选此角色可调用的本地工具。MCP 服务在下方单独选择。',
  };
  return <section className="role-editor-block">
    <div className="role-editor-row"><h3>工具权限</h3>
      <Select label="角色工具权限" value={mode} options={options({ inherit: accessLabels.inherit, 'read-only': accessLabels['read-only'],
        'read-write': accessLabels['read-write'], custom: accessLabels.custom, parent: accessLabels.parent })}
        onChange={next => onChange(next === inherit ? undefined : next === 'custom' ? [] : next as Exclude<Access, string[] | undefined>)} />
    </div>
    <p>{help[mode]}</p>
    {Array.isArray(access) && <div className="role-resource-choices">
      <input type="search" aria-label="筛选角色工具" placeholder="搜索工具名或说明" value={filter} onChange={e => setFilter(e.target.value)} />
      <div className="role-resource-list role-tool-list">{choices.map(name => <label key={name} title={descriptions[name]}>
        <input type="checkbox" checked={access.includes(name)} onChange={e => onChange(e.target.checked ? [...access, name] : access.filter(id => id !== name))} />
        <span>{name}{!tools.includes(name) && '（当前不可用）'}</span></label>)}
        {!choices.length && <p>没有匹配的工具</p>}</div>
    </div>}
  </section>;
}

type ChoiceKey = 'maxThinking' | 'defaultMode' | 'backgroundEnabled' | 'supervisorEnabled' | 'worktreeIsolation' | 'budgetAction';
type NumberKey = 'maxConcurrent' | 'maxSpawns' | 'waitTimeoutMs' | 'worktreeLimit' | 'budgetTokens' | 'budgetCostUsd';
const thinking = { off: '关闭', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };
const yesNo = { true: '允许', false: '关闭' };

export function roleThinkingError({ defaultThinking, maxThinking }: SubagentRuntimeOverrides, supportedThinking?: SubagentThinking[]) {
  if (defaultThinking && supportedThinking && !supportedThinking.includes(defaultThinking)) {
    return '当前模型不支持这个强度，请重新选择。';
  }
  if (defaultThinking && maxThinking && concreteThinkingLevels.indexOf(defaultThinking) > concreteThinkingLevels.indexOf(maxThinking)) {
    return `此角色的思考强度上限为「${thinking[maxThinking]}」，请降低强度或在更多运行设置中调整上限。`;
  }
  return '';
}

export function RoleThinkingField({ defaults, overrides, supportedThinking, onChange }: Props) {
  const messageId = useId();
  const error = roleThinkingError(overrides, supportedThinking);
  const common = defaults.defaultThinking ? thinking[defaults.defaultThinking] : '跟随父智能体';
  return <div className="role-field role-thinking-field" role="group" aria-label="思考强度"
    aria-invalid={error ? true : undefined} aria-describedby={error ? messageId : undefined}>
    <span>思考强度</span>
    <Select label="角色默认思考强度" value={overrides.defaultThinking ?? inherit}
      options={[{ value: inherit, label: '继承 · ' + common }, { value: '', label: '跟随父智能体' },
        ...concreteThinkingLevels.map(value => {
          const disabled = supportedThinking !== undefined && !supportedThinking.includes(value);
          return { value, label: thinking[value] + (disabled ? '（模型不支持）' : ''), disabled };
        })]}
      onChange={value => onChange('defaultThinking', value === inherit ? undefined : value as SubagentThinking)} />
    {error && <small id={messageId} className="role-field-error" role="alert">{error}</small>}
  </div>;
}

export function RoleRuntimeFields({ defaults, overrides, onChange, harnessCustomized = false, children }: Props & {
  harnessCustomized?: boolean; children?: ReactNode;
}) {
  const toast = useSettingsToast();
  const count = Object.keys(overrides).filter(key => key !== 'allowedTools' && key !== 'defaultThinking').length
    + Number(harnessCustomized);
  const background = overrides.backgroundEnabled ?? defaults.backgroundEnabled;
  const isolated = (overrides.worktreeIsolation ?? defaults.worktreeIsolation) !== 'off';
  function choice(key: ChoiceKey, label: string, values: Record<string, string>, disabled = false) {
    const common = values[String(defaults[key])];
    return <div className="role-editor-row"><span>{label}</span>
      <Select label={'角色' + label} disabled={disabled} value={overrides[key] === undefined ? inherit : String(overrides[key])}
        options={[{ value: inherit, label: '继承 · ' + common }, ...options(values)]}
        onChange={next => onChange(key, next === inherit ? undefined : typeof defaults[key] === 'boolean'
          ? next === 'true' : next as Exclude<SubagentRuntimeOverrides[ChoiceKey], boolean>)} />
    </div>;
  }
  function numeric(key: NumberKey, label: string, min: number, max: number, unit: string, disabled = false, scale = 1, step = '1') {
    const value = overrides[key];
    const id = 'role-' + key;
    return <div className="role-editor-row"><label htmlFor={id}>{label}</label><div className="role-number">
      <input id={id} type="number" min={min} max={max} step={step} disabled={disabled}
        inputMode={step === '1' ? 'numeric' : 'decimal'} aria-describedby={id + '-unit'}
        value={value === undefined ? '' : value / scale} placeholder={'继承 · ' + (defaults[key] / scale)}
        onChange={event => onChange(key, event.target.value === '' ? undefined
          : scale === 1 ? event.target.valueAsNumber : Math.round(event.target.valueAsNumber * scale))} />
      <small id={id + '-unit'}>{unit}</small>
      {value !== undefined && <button type="button" aria-label={label + '恢复继承'} title="恢复继承" disabled={disabled}
        onClick={event => {
          event.currentTarget.parentElement?.querySelector('input')?.focus();
          onChange(key, undefined);
        }}><RotateCcw aria-hidden="true" /></button>}
    </div></div>;
  }
  function group(title: string, fields: ReactNode) {
    return <section className="role-runtime-group"><h4>{title}</h4><div className="role-runtime-fields">{fields}</div></section>;
  }
  return <Accordion className="subagent-form-disclosure role-run-defaults" summary="更多运行设置"
    description="思考上限、后台调度、工作树、预算与 Harness"
    badge={count ? count + ' 项自定义' : undefined}>
    <div className="role-runtime-content">
      {group('推理限制', choice('maxThinking', '思考强度上限', { '': '不限制', ...thinking }))}
      {group('后台与调度', <>
        {choice('backgroundEnabled', '允许后台运行', yesNo)}
        {choice('defaultMode', '默认运行模式', { foreground: '前台', background: '后台' }, !background)}
        {choice('supervisorEnabled', '联系主智能体', yesNo, !background)}
        {numeric('maxConcurrent', '最大后台并发', 1, 16, '个', !background)}
        {numeric('maxSpawns', '最多创建', 1, 100, '个')}
        {numeric('waitTimeoutMs', '默认等待时间', 1, 600, '秒', !background, 1000, '0.001')}
        <p>自定义并发和创建上限按同一主会话内的这个角色计数。</p>
      </>)}
      {group('工作树', <>
        {choice('worktreeIsolation', '工作树隔离', { off: '共享工作区', background: '仅后台隔离', always: '始终隔离' })}
        {numeric('worktreeLimit', '工作树保留上限', 1, 50, '个', !isolated)}
        <div className="role-editor-row role-runtime-wide-field"><span>工作树位置</span><Select label="角色工作树位置" disabled={!isolated}
          value={overrides.worktreeParent === undefined ? inherit : overrides.worktreeParent ? 'path' : 'studio'}
          options={[{ value: inherit, label: '继承 · ' + (defaults.worktreeParent || 'Studio 数据目录') }, { value: 'studio', label: 'Studio 数据目录' },
            ...(overrides.worktreeParent ? [{ value: 'path', label: overrides.worktreeParent }] : []), { value: 'pick', label: '选择文件夹…' }]}
          onChange={async value => {
            if (value === 'pick') {
              try { const directory = await window.piApi.pickWorktreeParent(); if (directory) onChange('worktreeParent', directory); }
              catch (cause) { toast(errorText(cause), 'error'); }
            } else if (value !== 'path') onChange('worktreeParent', value === inherit ? undefined : '');
          }} /></div>
        <p>保留上限按整个 Git 仓库内的托管工作树计数。</p>
      </>)}
      {group('运行预算', <>
        {numeric('budgetTokens', 'Token 预算', 0, 100000000, 'tokens')}
        {numeric('budgetCostUsd', '参考成本预算', 0, 100000, 'USD', false, 1, 'any')}
        {choice('budgetAction', '达到预算后', { warn: '提醒', stop: '停止新任务' })}
        <p>自定义预算累计同一主会话内这个角色的用量。填 0 表示不限，留空跟随共用值。</p>
      </>)}
      {children && group('运行环境', children)}
    </div>
  </Accordion>;
}
