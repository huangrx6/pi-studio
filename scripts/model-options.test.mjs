import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getModel } from '@earendil-works/pi-ai/compat';
import { reasoningOptions, validateThinkingLevel } from '../electron/model-options.mjs';

const go = getModel('opencode-go', 'deepseek-v4.1-flash');
const mini = getModel('minimax-cn', 'MiniMax-M3.1-Flash');

test('Go DeepSeek exposes only its real supported levels, including native Max', () => {
  assert.ok(go);
  assert.deepEqual(reasoningOptions(go).thinkingLevels, ['default', 'low', 'high', 'max']);
  assert.equal(reasoningOptions(go, 'max').effectiveThinkingLevel, 'max');
  assert.throws(() => validateThinkingLevel(go, 'medium'), /不支持/);
  assert.throws(() => validateThinkingLevel(go, 'off'), /不支持/);
});

test('different models expose different levels and unsupported saved choices fall back to Default', () => {
  assert.ok(mini);
  assert.ok(reasoningOptions(mini).thinkingLevels.includes('xhigh'));
  assert.equal(reasoningOptions(go, 'xhigh').thinkingLevel, 'default');
  assert.equal(reasoningOptions(go, 'xhigh').effectiveThinkingLevel, 'high');
});

test('Default respects the exact provider/model override before the global default', () => {
  const settings = { defaultThinkingLevel: 'high', modelThinkingLevels: { 'opencode-go/deepseek-v4.1-flash': 'low' } };
  assert.equal(reasoningOptions(go, 'default', settings).effectiveThinkingLevel, 'low');
  assert.equal(reasoningOptions({ ...go, provider: 'different-source' }, 'default', settings).effectiveThinkingLevel, 'high');
  assert.equal(reasoningOptions(go, 'max', settings).effectiveThinkingLevel, 'max');
  assert.equal(reasoningOptions(go, 'max', settings).defaultThinkingLevel, 'low');
});

test('non-reasoning and custom restricted models cannot advertise ineffective controls', () => {
  const plain = { ...go, reasoning: false };
  assert.deepEqual(reasoningOptions(plain).thinkingLevels, ['default']);
  assert.equal(reasoningOptions(plain, 'max').effectiveThinkingLevel, 'off');
  assert.throws(() => validateThinkingLevel(plain, 'high'), /不支持/);
  const custom = { ...go, thinkingLevelMap: { off: 'disabled', minimal: null, low: null, medium: null, high: 'turbo', xhigh: null, max: null } };
  assert.deepEqual(reasoningOptions(custom).thinkingLevels, ['default', 'off', 'high']);
});

test('Pi sessions receive the resolved level and record later changes without a model request', async () => {
  const { createAgentSession, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent');
  const folder = mkdtempSync(join(tmpdir(), 'pi-thinking-'));
  let session;
  try {
    const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel: 'low' });
    const modelRuntime = await ModelRuntime.create({ authPath: join(folder, 'auth.json'), modelsPath: join(folder, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
    const resourceLoader = new DefaultResourceLoader({ cwd: folder, agentDir: folder, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const manager = SessionManager.inMemory(folder);
    ({ session } = await createAgentSession({ cwd: folder, agentDir: folder, model: go, modelRuntime, settingsManager, resourceLoader, sessionManager: manager, noTools: 'all', thinkingLevel: reasoningOptions(go, 'max').effectiveThinkingLevel }));
    assert.equal(session.thinkingLevel, 'max');
    session.setThinkingLevel(reasoningOptions(go, 'default', { defaultThinkingLevel: 'low' }).effectiveThinkingLevel);
    assert.equal(session.thinkingLevel, 'low');
    assert.equal(manager.getEntries().filter((entry) => entry.type === 'thinking_level_change').at(-1).thinkingLevel, 'low');
  } finally { session?.dispose(); rmSync(folder, { recursive: true, force: true }); }
});
