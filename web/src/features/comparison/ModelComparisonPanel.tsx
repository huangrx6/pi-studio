import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Columns2,
  ExternalLink,
  FileDiff,
  LoaderCircle,
  Play,
  Trash2,
} from 'lucide-react';
import { Select } from '../../shared/Select';
import { Markdown } from '../../shared/Markdown';
import { useActionConfirmation } from '../../shared/ConfirmDialog';
import { InfoHint } from '../../shared/InfoHint';
import { reconcileComparisonSnapshot } from './comparison-state';
import {
  thinkingLabels,
  type ModelCatalog,
  type ModelOption,
  type ThinkingLevel,
} from '../../types/model-types';
import type {
  ModelComparisonBranchStatus,
  ModelComparisonSnapshot,
  ModelComparisonStartResult,
} from '../../types/comparison-types';
import './model-comparison.css';

type ComposerImage = { type: 'image'; data: string; mimeType: string };

function compactTokens(value: number): string {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(tokens));
}

function duration(value?: number): string {
  const ms = Math.max(0, Number(value) || 0);
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`; // taste-skill-ignore numbering
}

function statusText(status: ModelComparisonBranchStatus['status']): string {
  if (status === 'running') return '运行中';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'missing') return '已丢失';
  if (status === 'discarded') return '已丢弃';
  return '未返回';
}

function modelOptions(catalog: ModelCatalog | null, requireImages: boolean): ModelOption[] {
  if (!catalog) return [];
  const enabled = new Set(catalog.enabled || []);
  return catalog.models.filter((model) => (
    (enabled.size === 0 || enabled.has(model.id) || model.id === catalog.current)
    && (!requireImages || model.supportsImages === true)
  ));
}

function resultMetrics(result: ModelComparisonBranchStatus) {
  return [
    ['TTFT', result.metrics.ttftMs ? duration(result.metrics.ttftMs) : '—'],
    ['速率', result.metrics.tps ? `${result.metrics.tps.toFixed(1)} tok/s` : '—'],
    ['耗时', result.metrics.durationMs ? duration(result.metrics.durationMs) : '—'],
    ['Token', compactTokens(result.metrics.tokens)],
    ['成本', result.metrics.costUsd ? `$${result.metrics.costUsd.toFixed(4)}` : '未回传'],
    ['请求', String(result.metrics.requests)],
  ];
}

export function ModelComparisonPanel({
  parentId,
  cwd,
  initialPrompt,
  initialComparison,
  initialModelRef,
  initialThinkingLevel,
  mentions,
  attachments,
  images,
  onStarted,
  onAdopt,
  onManageModels,
}: {
  parentId: string;
  cwd: string;
  initialPrompt: string;
  initialComparison?: ModelComparisonStartResult | null;
  initialModelRef: string;
  initialThinkingLevel: ThinkingLevel;
  mentions: string[];
  attachments: string[];
  images: ComposerImage[];
  onStarted: (comparison: ModelComparisonStartResult) => void;
  onAdopt: (sessionId: string) => void;
  onManageModels: () => void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [prompt, setPrompt] = useState(initialPrompt);
  const [leftModel, setLeftModel] = useState(initialModelRef);
  const [rightModel, setRightModel] = useState('');
  const [leftThinking, setLeftThinking] = useState<ThinkingLevel>(initialThinkingLevel);
  const [rightThinking, setRightThinking] = useState<ThinkingLevel>('default');
  const [comparison, setComparison] = useState<ModelComparisonStartResult | null>(initialComparison ?? null);
  const [results, setResults] = useState<ModelComparisonSnapshot | null>(null);
  const [starting, setStarting] = useState(false);
  const [adopting, setAdopting] = useState('');
  const [discarding, setDiscarding] = useState('');
  const [error, setError] = useState('');
  const initialized = useRef(false);
  const actionPending = useRef(false);
  const confirmation = useActionConfirmation();

  useEffect(() => {
    setComparison(initialComparison ?? null);
    setResults(null);
    setError('');
  }, [initialComparison]);

  useEffect(() => {
    let disposed = false;
    window.piApi.models(cwd)
      .then((next) => {
        if (disposed) return;
        setCatalog(next);
        setCatalogError('');
      })
      .catch((cause) => {
        if (!disposed) setCatalogError(cause instanceof Error ? cause.message : '模型目录加载失败');
      });
    return () => { disposed = true; };
  }, [cwd]);

  const availableModels = useMemo(
    () => modelOptions(catalog, images.length > 0),
    [catalog, images.length],
  );
  const left = availableModels.find((model) => model.id === leftModel);
  const right = availableModels.find((model) => model.id === rightModel);

  useEffect(() => {
    if (initialized.current || availableModels.length === 0) return;
    initialized.current = true;
    const preferredLeft = availableModels.find((model) => model.id === initialModelRef)
      || availableModels[0];
    const preferredRight = availableModels.find((model) => model.id !== preferredLeft.id);
    setLeftModel(preferredLeft.id);
    setRightModel(preferredRight?.id || '');
    setLeftThinking(
      preferredLeft.thinkingLevels?.includes(initialThinkingLevel as never)
        ? initialThinkingLevel
        : 'default',
    );
    setRightThinking(
      preferredRight?.thinkingLevels?.includes(initialThinkingLevel as never)
        ? initialThinkingLevel
        : 'default',
    );
  }, [availableModels, initialModelRef, initialThinkingLevel]);

  useEffect(() => {
    if (!comparison) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await window.piApi.conversationCompareSnapshot({
          branches: comparison.branches,
        });
        if (disposed) return;
        setResults((current) => reconcileComparisonSnapshot(current, next));
        setError('');
        if (next.some((branch) => branch.running)) {
          timer = window.setTimeout(poll, 1_200);
        }
      } catch (cause) {
        if (disposed) return;
        setError(cause instanceof Error ? cause.message : '读取模型对比状态失败');
        timer = window.setTimeout(poll, 2_000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [comparison]);

  const canStart = Boolean(
    parentId
    && prompt.trim()
    && leftModel
    && rightModel
    && leftModel !== rightModel
    && availableModels.length >= 2
    && !starting
    && !comparison,
  );

  async function start() {
    if (!canStart) return;
    setStarting(true);
    setError('');
    try {
      const started = await window.piApi.conversationCompareStart({
        parentId,
        prompt: prompt.trim(),
        mentions,
        attachments,
        images,
        branches: [
          {
            label: left?.name || leftModel,
            modelRef: leftModel,
            thinkingLevel: leftThinking,
          },
          {
            label: right?.name || rightModel,
            modelRef: rightModel,
            thinkingLevel: rightThinking,
          },
        ],
      });
      setComparison(started);
      onStarted(started);
      setResults([
        {
          sessionId: started.branches[0].sessionId,
          label: started.branches[0].label,
          modelRef: started.branches[0].modelRef,
          worktreeId: started.branches[0].worktreeId,
          status: 'running',
          title: started.branches[0].label,
          cwd,
          running: true,
          compacting: false,
          metrics: { requests: 0, tokens: 0, costUsd: 0 },
        },
        {
          sessionId: started.branches[1].sessionId,
          label: started.branches[1].label,
          modelRef: started.branches[1].modelRef,
          worktreeId: started.branches[1].worktreeId,
          status: 'running',
          title: started.branches[1].label,
          cwd,
          running: true,
          compacting: false,
          metrics: { requests: 0, tokens: 0, costUsd: 0 },
        },
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法开始模型对比');
    } finally {
      setStarting(false);
    }
  }

  async function adopt(result: ModelComparisonBranchStatus) {
    if (actionPending.current || result.status !== 'completed') return;
    actionPending.current = true;
    setAdopting(result.sessionId);
    setError('');
    try {
      await window.piApi.conversationCompareAdopt({
        sessionId: result.sessionId,
        worktreeId: result.worktreeId,
      });
      onAdopt(result.sessionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法应用这个分支');
    } finally {
      actionPending.current = false;
      setAdopting('');
    }
  }

  async function discardBranch(result: ModelComparisonBranchStatus) {
    if (actionPending.current || result.status === 'discarded') return;
    const accepted = await confirmation.confirm({
      title: '丢弃这个对比分支？',
      description: '分支会话、聊天记录和托管工作树中的未合并改动会被永久删除。原工作区不会被修改。',
      confirmLabel: '丢弃分支',
      tone: 'danger',
    });
    if (!accepted || actionPending.current) return;
    actionPending.current = true;
    setDiscarding(result.sessionId);
    setError('');
    try {
      await window.piApi.conversationCompareDiscard({
        sessionId: result.sessionId,
        worktreeId: result.worktreeId,
      });
      setResults((current) => current?.map((item) => (
        item.sessionId === result.sessionId
          ? {
              ...item,
              status: 'discarded',
              running: false,
              compacting: false,
              answer: undefined,
              worktree: item.worktree
                ? { ...item.worktree, status: 'discarded', directoryExists: false }
                : item.worktree,
            }
          : item
      )) as ModelComparisonSnapshot | null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法丢弃这个分支');
    } finally {
      actionPending.current = false;
      setDiscarding('');
    }
  }

  function modelSelect(value: string, onChange: (value: string) => void, label: string) {
    return <Select
      label={label}
      value={value}
      options={availableModels.map((model) => ({
        value: model.id,
        label: model.name,
        description: `${model.providerName} · ${model.id}`,
      }))}
      onChange={onChange}
      disabled={Boolean(comparison) || starting}
    />;
  }

  function thinkingSelect(
    value: ThinkingLevel,
    model: ModelOption | undefined,
    onChange: (value: ThinkingLevel) => void,
    label: string,
  ) {
    const levels = model?.thinkingLevels?.length
      ? ['default', ...model.thinkingLevels] as ThinkingLevel[]
      : ['default'] as ThinkingLevel[];
    return <Select
      label={label}
      value={value}
      options={levels.map((level) => ({ value: level, label: thinkingLabels[level] }))}
      onChange={(next) => onChange(next as ThinkingLevel)}
      disabled={Boolean(comparison) || starting || levels.length <= 1}
    />;
  }

  return <section className="model-comparison" aria-label="模型同题双跑">
    {!comparison ? <div className="comparison-form">
      <label className="comparison-prompt">
        <span className="comparison-field-label">要对比的问题</span>
        <textarea
          autoFocus
          value={prompt}
          maxLength={200_000}
          placeholder="输入问题"
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      {(images.length > 0 || attachments.length > 0) && <p className="comparison-input-note">
        两个分支将收到相同的{images.length ? ` ${images.length} 张图片` : ''}
        {images.length && attachments.length ? '和' : ''}
        {attachments.length ? `${attachments.length} 个附件` : ''}。
      </p>}

      {availableModels.length < 2 ? <div className="comparison-unavailable">
        <AlertTriangle />
        <span>
          <strong>{catalogError || (images.length ? '至少启用两个支持图片的模型' : '至少启用两个模型')}</strong>
        </span>
        <button type="button" className="secondary-button" onClick={onManageModels}>管理模型</button>
      </div> : <div className="comparison-config">
        <div className="comparison-config-side">
          <div className="comparison-side-head">
            <span className="comparison-side-label">A</span>
            <strong>分支 A</strong>
          </div>
          <div className="comparison-controls">
            {modelSelect(leftModel, (value) => {
              setLeftModel(value);
              setLeftThinking('default');
            }, '分支 A 模型')}
            {thinkingSelect(leftThinking, left, setLeftThinking, '分支 A 思考强度')}
          </div>
        </div>
        <div className="comparison-config-side">
          <div className="comparison-side-head">
            <span className="comparison-side-label">B</span>
            <strong>分支 B</strong>
          </div>
          <div className="comparison-controls">
            {modelSelect(rightModel, (value) => {
              setRightModel(value);
              setRightThinking('default');
            }, '分支 B 模型')}
            {thinkingSelect(rightThinking, right, setRightThinking, '分支 B 思考强度')}
          </div>
        </div>
      </div>}

      {leftModel && rightModel && leftModel === rightModel && <p className="comparison-inline-warning">
        两个分支需要选择不同的模型。
      </p>}
      {error && <p className="comparison-error" role="alert">{error}</p>}
      <footer className="comparison-start-row">
        <InfoHint
          align="end"
          className="comparison-start-hint"
          label="两个模型分别计费；隔离分支不会修改原对话，文件改动保留在隔离工作树中。"
        />
        <button type="button" className="primary-button comparison-start-button" disabled={!canStart} onClick={() => void start()}>
          {starting ? <LoaderCircle className="spin" /> : <Play />}
          {starting ? '正在创建分支' : '开始双跑'}
        </button>
      </footer>
    </div> : <div className="comparison-results">
      <header className="comparison-run-summary">
        <span><Columns2 />同一问题</span>
        <p title={comparison.prompt}>{comparison.prompt}</p>
      </header>
      {(results || []).map((result, index) => <article className={`comparison-result is-${result.status}`} key={result.sessionId}>
        <header>
          <div className="comparison-result-identity">
            <span className="comparison-side-label">{index === 0 ? 'A' : 'B'}</span>
            <div>
              <strong>{result.label}</strong>
              <code>{result.modelRef}</code>
            </div>
          </div>
          <span className="comparison-result-status">
            {result.status === 'running'
              ? <LoaderCircle className="spin" />
              : result.status === 'completed'
                ? <CheckCircle2 />
                : <AlertTriangle />}
            {statusText(result.status)}
          </span>
        </header>
        <dl className="comparison-metrics">
          {resultMetrics(result).map(([label, value]) => <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>)}
        </dl>
        <div className="comparison-answer">
          {result.answer?.error
            ? <p className="comparison-error">{result.answer.error}</p>
            : result.answer?.text
              ? <Markdown>{result.answer.text}</Markdown>
              : <p className="comparison-waiting">
                {result.status === 'discarded' ? '分支已丢弃。' : result.running ? '模型正在处理同一问题…' : '这个分支没有可展示的回答。'}
              </p>}
        </div>
        {result.worktree && result.worktree.changedFiles > 0 && <div className="comparison-worktree">
          <span><FileDiff />{result.worktree.changedFiles} 个文件有改动</span>
          <small>{result.worktree.files.slice(0, 4).map((file) => file.path).join(' · ')}
            {result.worktree.files.length > 4 ? ` 等 ${result.worktree.files.length} 个` : ''}
          </small>
        </div>}
        {result.worktree?.error && <p className="comparison-inline-warning">{result.worktree.error}</p>}
        <footer>
          <span>思考强度：{thinkingLabels[comparison.branches[index].thinkingLevel]}</span>
          <div className="comparison-result-actions">
            <button
              type="button"
              className="comparison-discard"
              disabled={result.status === 'discarded' || Boolean(adopting || discarding)}
              onClick={() => void discardBranch(result)}
            >
              {discarding === result.sessionId ? <LoaderCircle className="spin" /> : <Trash2 />}
              <span>{result.status === 'discarded' ? '已丢弃' : '丢弃'}</span>
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={result.status !== 'completed' || Boolean(adopting || discarding)}
              onClick={() => void adopt(result)}
            >
              {adopting === result.sessionId ? <LoaderCircle className="spin" /> : <ExternalLink />}
              <span>{result.worktree?.changedFiles ? '应用并打开' : '打开分支'}</span>
            </button>
          </div>
        </footer>
      </article>)}
      {error && <p className="comparison-error" role="alert">{error}</p>}
    </div>}
    {confirmation.dialog}
  </section>;
}
