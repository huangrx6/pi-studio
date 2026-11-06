import assert from 'node:assert/strict';
import test from 'node:test';
import { isLongTaskDetailLong, longTaskPresentation } from '../../web/src/features/conversation/long-task-presentation.ts';

const state = (overrides = {}) => ({
  enabled: true, goal: '改进交互体验', completionCriteria: '', status: 'active', iteration: 3,
  lastProgress: '检查了组件', nextStep: '验证键盘操作', pauseReason: '', completionSummary: '',
  blockReason: '', createdAt: 1, updatedAt: 2, completedAt: 0, blockedAt: 0, ...overrides,
});

test('active status claims execution only while the conversation is actually running', () => {
  const waiting = longTaskPresentation(state(), false);
  assert.equal(waiting.label, '等待继续');
  assert.equal(waiting.isRunning, false);
  assert.equal(waiting.canResume, true);
  assert.equal(waiting.canPause, true);
  const running = longTaskPresentation(state(), true);
  assert.equal(running.label, '目标执行中');
  assert.equal(running.isRunning, true);
  assert.equal(running.canResume, false);
  assert.equal(running.canPause, true);
});

test('pause/resume availability follows supported commands even when the conversation is busy', () => {
  for (const running of [false, true]) {
    for (const [status, resume, pause] of [
      ['idle', false, false], ['paused', true, false], ['blocked', true, true], ['failed', false, false],
    ]) {
      const view = longTaskPresentation(state({ status }), running);
      assert.equal(view.canResume, resume, `${status}, running=${running}: resume`);
      assert.equal(view.canPause, pause, `${status}, running=${running}: pause`);
      assert.equal(view.isRunning, false, `${status} is not executing the goal`);
    }
  }
});

test('failed goals keep their goal and recovery guidance without exposing obsolete next steps', () => {
  const view = longTaskPresentation(state({ status: 'failed', nextStep: 'OLD_NEXT_STEP', lastProgress: 'OLD_PROGRESS', pauseReason: 'OLD_PAUSE', blockReason: 'OLD_BLOCK' }), false);
  assert.equal(view.goal, '改进交互体验');
  assert.equal(view.label, '执行失败');
  assert.match(view.detail, /对话中的错误信息/);
  assert.ok(!view.detail.includes('OLD_'));
});

test('paused and blocked goals show their actual reason without replacing the goal', () => {
  const paused = longTaskPresentation(state({ status: 'paused', pauseReason: '等待用户检查结果' }), false);
  assert.equal(paused.detail, '等待用户检查结果');
  assert.equal(paused.goal, '改进交互体验');
  const blocked = longTaskPresentation(state({ status: 'blocked', blockReason: '缺少项目权限' }), false);
  assert.equal(blocked.label, '等待处理');
  assert.equal(blocked.detail, '缺少项目权限');
  assert.equal(blocked.goal, '改进交互体验');
  assert.ok(!longTaskPresentation(state({ status: 'paused' }), false).detail.includes('验证键盘操作'));
});

test('active goals distinguish the next step from previously recorded progress', () => {
  assert.equal(longTaskPresentation(state(), true).detail, '下一步：验证键盘操作');
  assert.equal(longTaskPresentation(state({ nextStep: '' }), true).detail, '最近进展：检查了组件');
  assert.equal(longTaskPresentation(state({ nextStep: '', lastProgress: '' }), true).detail, '');
});

test('disabled or missing goals never offer unsupported controls or imply execution', () => {
  for (const override of [{ enabled: false }, { goal: '' }, { goal: '   ' }]) {
    const view = longTaskPresentation(state(override), true);
    assert.equal(view.canResume, false);
    assert.equal(view.canPause, false);
    assert.equal(view.isRunning, false);
    assert.notEqual(view.label, '目标执行中');
  }
});

test('absent and completed goals do not leave a persistent dock', () => {
  assert.equal(longTaskPresentation(undefined, false), null);
  assert.equal(longTaskPresentation(state({ enabled: false, goal: '' }), false), null);
  for (const running of [false, true]) assert.equal(longTaskPresentation(state({ status: 'completed' }), running), null);
});

test('only content with an expansion affordance is eligible for truncation', () => {
  assert.equal(isLongTaskDetailLong('短原因完整换行显示'), false);
  assert.equal(isLongTaskDetailLong('原'.repeat(80)), false);
  assert.equal(isLongTaskDetailLong('原'.repeat(81)), true);
  assert.equal(isLongTaskDetailLong('第一行\n第二行'), true);
});
