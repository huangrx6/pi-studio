import type { Dispatch, Ref, SetStateAction } from 'react';
import { Accordion } from '../../shared/Accordion';
import { Select } from '../../shared/Select';
import type { RuntimePolicy } from '../../types/harness-types';

const timeoutChoices = [0, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000];
const retentionChoices = [0, 30_000, 90_000, 300_000, 600_000, 1_800_000, 3_600_000];

function durationLabel(ms: number) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  if (ms % 1_000 === 0) return `${ms / 1_000} 秒`;
  return `${ms} 毫秒`;
}

function DurationField({ label, value, choices, zeroLabel, onChange }: {
  label: string; value: number; choices: number[]; zeroLabel: string; onChange: (value: number) => void;
}) {
  // 已有策略可保存预设以外的时长，编辑其它字段时也要显示其实际值。
  const values = choices.includes(value) ? choices : [...choices, value].sort((a, b) => a - b);
  return <div className="harness-field">
    <span>{label}</span>
    <Select label={label} value={String(value)} options={values.map(ms => ({
      value: String(ms), label: ms === 0 ? zeroLabel : durationLabel(ms),
    }))} onChange={next => onChange(Number(next))} />
  </div>;
}

function NumberField({ label, accessibleLabel, value, min, max, unit, disabled, error, onChange }: {
  label: string; accessibleLabel?: string; value: number; min: number; max: number;
  unit?: string; disabled?: boolean; error?: string; onChange: (value: number) => void;
}) {
  return <label className="harness-field">
    <span>{label}{unit && <small>（{unit}）</small>}</span>
    <input type="number" required min={min} max={max} disabled={disabled} value={value}
      aria-label={accessibleLabel} ref={input => { input?.setCustomValidity(error || ''); }}
      onChange={event => onChange(Number(event.target.value))} />
  </label>;
}

function PolicySwitch({ label, enabled, onChange, buttonRef }: {
  label: string; enabled: boolean; onChange: () => void; buttonRef?: Ref<HTMLButtonElement>;
}) {
  return <div className="harness-setting-row">
    <span>{label}</span>
    <button ref={buttonRef} type="button" className={`switch ${enabled ? 'is-on' : ''}`} role="switch"
      aria-label={label} aria-checked={enabled} onClick={onChange}><span /></button>
  </div>;
}

export function HarnessRuntimeFields({ policy, setPolicy, compactionSwitch, revealCompaction }: {
  policy: RuntimePolicy; setPolicy: Dispatch<SetStateAction<RuntimePolicy>>;
  compactionSwitch: Ref<HTMLButtonElement>; revealCompaction: boolean;
}) {
  const { retry, compaction, longTask } = policy;
  const threshold = compaction.autoCompactPercent;
  const compressionSummary = !compaction.enabled ? '已关闭' : threshold ? `达到 ${threshold}% 时压缩` : '按 token 阈值压缩';

  return <>
    <Accordion className="harness-disclosure harness-policy-group" summary="请求与重试" defaultOpen
      badge={retry.enabled ? `最多重试 ${retry.maxRetries} 次` : '自动重试已关闭'}>
      <div className="harness-disclosure-body">
        <PolicySwitch label="自动重试" enabled={retry.enabled}
          onChange={() => setPolicy(current => ({ ...current, retry: { ...current.retry, enabled: !current.retry.enabled } }))} />
        <div className="harness-policy-fields">
          <NumberField label="最大重试次数" value={retry.maxRetries} min={0} max={10} disabled={!retry.enabled}
            onChange={maxRetries => setPolicy(current => ({ ...current, retry: { ...current.retry, maxRetries } }))} />
          <NumberField label="首次等待" unit="毫秒" value={retry.baseDelayMs} min={100} max={60_000} disabled={!retry.enabled}
            onChange={baseDelayMs => setPolicy(current => ({ ...current, retry: { ...current.retry, baseDelayMs } }))} />
          <DurationField label="单次请求超时" value={policy.streamTimeoutMs} choices={timeoutChoices} zeroLabel="使用服务商默认值"
            onChange={streamTimeoutMs => setPolicy(current => ({ ...current, streamTimeoutMs }))} />
        </div>
      </div>
    </Accordion>
    <Accordion className="harness-disclosure harness-policy-group" summary="工具调度与恢复"
      badge={policy.toolExecution === 'parallel' ? '并行执行' : '顺序执行'}>
      <div className="harness-disclosure-body harness-policy-fields">
        <div className="harness-field">
          <span>工具执行顺序</span>
          <Select label="工具执行顺序" value={policy.toolExecution} options={[
            { value: 'parallel', label: '并行', description: '同一轮中互不依赖的工具调用可以同时执行。' },
            { value: 'sequential', label: '顺序', description: '同一轮内逐个执行工具，方便检查每一步结果。' },
          ]} onChange={value => setPolicy(current => ({ ...current, toolExecution: value as RuntimePolicy['toolExecution'] }))} />
        </div>
        <div className="harness-field">
          <span>失败后排队输入</span>
          <Select label="失败后排队输入" value={policy.afterFailedRun} options={[
            { value: 'keep', label: '保留等待', description: '保留排队中的输入，等待你继续。' },
            { value: 'continue', label: '继续执行', description: '直接开始处理下一条输入。' },
            { value: 'withdraw', label: '撤回', description: '将排队输入标记为未回答。' },
          ]} onChange={value => setPolicy(current => ({ ...current, afterFailedRun: value as RuntimePolicy['afterFailedRun'] }))} />
        </div>
        <NumberField label="崩溃重启上限" unit="次" value={policy.restartLimit} min={1} max={50}
          onChange={restartLimit => setPolicy(current => ({ ...current, restartLimit }))} />
      </div>
    </Accordion>
    <Accordion className="harness-disclosure harness-policy-group" summary="上下文压缩" badge={compressionSummary}
      defaultOpen={revealCompaction}>
      <div className="harness-disclosure-body">
        <PolicySwitch label="自动压缩上下文" enabled={compaction.enabled} buttonRef={compactionSwitch}
          onChange={() => setPolicy(current => ({ ...current, compaction: { ...current.compaction, enabled: !current.compaction.enabled } }))} />
        <div className="harness-policy-fields">
          <NumberField label="触发阈值" unit="%" accessibleLabel="自动压缩触发阈值（百分比）" value={threshold}
            min={0} max={95} disabled={!compaction.enabled} error={threshold > 0 && threshold < 50 ? '请输入 50 至 95，或输入 0 以使用 token 阈值。' : undefined}
            onChange={autoCompactPercent => setPolicy(current => ({ ...current, compaction: { ...current.compaction, autoCompactPercent } }))} />
          <NumberField label="保留最近内容" unit="token" value={compaction.keepRecentTokens} min={0} max={262_144} disabled={!compaction.enabled}
            onChange={keepRecentTokens => setPolicy(current => ({ ...current, compaction: { ...current.compaction, keepRecentTokens } }))} />
        </div>
        <p>阈值按模型的上下文窗口计算。填 0 或窗口大小未知时，使用下方的 token 设置。</p>
        <Accordion className="harness-disclosure harness-policy-details" summary="按 token 细调">
          <div className="harness-disclosure-body harness-policy-fields">
            <NumberField label="回答预留" unit="token" value={compaction.reserveTokens} min={1_024} max={262_144} disabled={!compaction.enabled}
              onChange={reserveTokens => setPolicy(current => ({ ...current, compaction: { ...current.compaction, reserveTokens } }))} />
            <NumberField label="后台压缩提前量" unit="token" value={compaction.backgroundTokens} min={0} max={262_144} disabled={!compaction.enabled}
              onChange={backgroundTokens => setPolicy(current => ({ ...current, compaction: { ...current.compaction, backgroundTokens } }))} />
          </div>
        </Accordion>
      </div>
    </Accordion>
    <Accordion className="harness-disclosure harness-policy-group" summary="长期任务" badge={`最多 ${longTask.maxContinuations} 轮`}>
      <div className="harness-disclosure-body">
        <p>达到任一上限时暂停任务，等待确认。</p>
        <div className="harness-policy-fields">
          <NumberField label="单次运行轮次上限" value={longTask.maxContinuations} min={1} max={500}
            onChange={maxContinuations => setPolicy(current => ({ ...current, longTask: { ...current.longTask, maxContinuations } }))} />
          <NumberField label="连续无进展上限" value={longTask.maxStalledContinuations} min={1} max={50}
            onChange={maxStalledContinuations => setPolicy(current => ({ ...current, longTask: { ...current.longTask, maxStalledContinuations } }))} />
        </div>
      </div>
    </Accordion>
    <Accordion className="harness-disclosure harness-policy-group" summary="内存缓存"
      badge={policy.contextRetentionMs ? `会话保留 ${durationLabel(policy.contextRetentionMs)}` : '会话空闲后释放'}>
      <div className="harness-disclosure-body harness-policy-fields">
        <DurationField label="会话上下文缓存" value={policy.contextRetentionMs} choices={retentionChoices} zeroLabel="空闲后立即释放"
          onChange={contextRetentionMs => setPolicy(current => ({ ...current, contextRetentionMs }))} />
        <DurationField label="辅助文档缓存" value={policy.documentRetentionMs} choices={retentionChoices} zeroLabel="使用后立即释放"
          onChange={documentRetentionMs => setPolicy(current => ({ ...current, documentRetentionMs }))} />
      </div>
    </Accordion>
  </>;
}
