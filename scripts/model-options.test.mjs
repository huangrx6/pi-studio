/**
 * electron/model-options.mjs 的单元测试。
 *
 * 覆盖：按模型真实能力计算推理等级（thinking level）选项、Default 的解析优先级、
 *       非推理 / 自定义映射模型的降级规则，以及把解析结果交给 Pi 会话后的行为。
 *
 * 运行方式：
 *   pnpm test                                 # 跑 scripts/ 下全部单测
 *   node --test scripts/model-options.test.mjs  # 只跑本文件
 *
 * 依赖：
 * - @earendil-works/pi-ai/compat：getModel 提供真实模型元数据；
 * - @earendil-works/pi-coding-agent：最后一个用例用来创建真实会话；
 * - electron/model-options.mjs：被测模块；
 * - node:fs / os / path：为 SDK 创建临时目录。
 * 所有用例都不访问网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getModel } from '@earendil-works/pi-ai/compat';
import { reasoningOptions, validateThinkingLevel } from '../electron/model-options.mjs';

// 使用真实模型目录而非手写 fixture：Go 的 DeepSeek 只支持 low/high/max
//（没有 medium / off），MiniMax 则支持 xhigh，两者足够覆盖能力差异。
const go = getModel('opencode-go', 'deepseek-v4.1-flash');
const minimax = getModel('minimax-cn', 'MiniMax-M3.1-Flash');

// reasoningOptions 必须按模型的真实能力给出等级，不能凭界面统一写死：
// Go DeepSeek 只暴露 default/low/high/max；显式选择 max 时原样生效；
// medium、off 不在支持列表里，validateThinkingLevel 应直接报错而不是悄悄降级。
test('Go DeepSeek exposes only its real supported levels, including native Max', () => {
  assert.ok(go);
  assert.deepEqual(reasoningOptions(go).thinkingLevels, ['default', 'low', 'high', 'max']);
  assert.equal(reasoningOptions(go, 'max').effectiveThinkingLevel, 'max');
  assert.throws(() => validateThinkingLevel(go, 'medium'), /不支持/);
  assert.throws(() => validateThinkingLevel(go, 'off'), /不支持/);
});

// 不同模型的能力不同（MiniMax 支持 xhigh）。用户保存的旧选择如果不再被当前
// 模型支持，thinkingLevel 应回落到 'default'，但 effectiveThinkingLevel 仍要
// 按默认值夹取到模型支持的档位：Go 上默认值 medium 会被 clamp 成 high。
test('different models expose different levels and unsupported saved choices fall back to Default', () => {
  assert.ok(minimax);
  assert.ok(reasoningOptions(minimax).thinkingLevels.includes('xhigh'));
  assert.equal(reasoningOptions(go, 'xhigh').thinkingLevel, 'default');
  assert.equal(reasoningOptions(go, 'xhigh').effectiveThinkingLevel, 'high');
});

// “Default”的解析优先级：modelThinkingLevels['provider/model'] 精确覆盖优先于
// 全局 defaultThinkingLevel；模型来源不匹配时用全局值。显式选择的非 default
// 等级不受默认值影响；defaultThinkingLevel 字段报告解析后的默认等级。
test('Default respects the exact provider/model override before the global default', () => {
  const settings = {
    defaultThinkingLevel: 'high',
    modelThinkingLevels: { 'opencode-go/deepseek-v4.1-flash': 'low' },
  };
  assert.equal(reasoningOptions(go, 'default', settings).effectiveThinkingLevel, 'low');
  assert.equal(
    reasoningOptions({ ...go, provider: 'different-source' }, 'default', settings).effectiveThinkingLevel,
    'high',
  );
  assert.equal(reasoningOptions(go, 'max', settings).effectiveThinkingLevel, 'max');
  assert.equal(reasoningOptions(go, 'max', settings).defaultThinkingLevel, 'low');
});

// 非推理模型不能暴露无效控件：可选等级只有 default，实际生效为 off，
// 选择 high 应报错。自定义 thinkingLevelMap 里值为 null 的等级视为未映射，
// 不出现在可选列表中（这里只剩 off 与 high 可用）。
test('non-reasoning and custom restricted models cannot advertise ineffective controls', () => {
  const plain = { ...go, reasoning: false };
  assert.deepEqual(reasoningOptions(plain).thinkingLevels, ['default']);
  assert.equal(reasoningOptions(plain, 'max').effectiveThinkingLevel, 'off');
  assert.throws(() => validateThinkingLevel(plain, 'high'), /不支持/);
  const custom = {
    ...go,
    thinkingLevelMap: {
      off: 'disabled',
      minimal: null,
      low: null,
      medium: null,
      high: 'turbo',
      xhigh: null,
      max: null,
    },
  };
  assert.deepEqual(reasoningOptions(custom).thinkingLevels, ['default', 'off', 'high']);
});

// 端到端：把解析后的 max 传给 createAgentSession，会话应真正处于 max；
// 之后 setThinkingLevel('low') 只向 SessionManager 追加一条
// thinking_level_change 记录，用于持久化用户选择，不触发模型请求。
// 临时目录隔离配置，finally 中释放会话并清理文件。
test('Pi sessions receive the resolved level and record later changes without a model request', async () => {
  const {
    createAgentSession,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    DefaultResourceLoader,
  } = await import('@earendil-works/pi-coding-agent');
  const folder = mkdtempSync(join(tmpdir(), 'pi-thinking-'));
  let session;
  try {
    const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel: 'low' });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(folder, 'auth.json'),
      modelsPath: join(folder, 'models.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    // 只加载必要资源，关闭扩展 / 技能 / 提示模板 / 主题 / 上下文文件，
    // 让用例不依赖用户真实配置。
    const resourceLoader = new DefaultResourceLoader({
      cwd: folder,
      agentDir: folder,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const manager = SessionManager.inMemory(folder);
    ({ session } = await createAgentSession({
      cwd: folder,
      agentDir: folder,
      model: go,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: manager,
      noTools: 'all',
      thinkingLevel: reasoningOptions(go, 'max').effectiveThinkingLevel,
    }));

    assert.equal(session.thinkingLevel, 'max');
    session.setThinkingLevel(
      reasoningOptions(go, 'default', { defaultThinkingLevel: 'low' }).effectiveThinkingLevel,
    );
    assert.equal(session.thinkingLevel, 'low');
    assert.equal(
      manager.getEntries().filter((entry) => entry.type === 'thinking_level_change').at(-1).thinkingLevel,
      'low',
    );
  } finally {
    session?.dispose();
    rmSync(folder, { recursive: true, force: true });
  }
});
