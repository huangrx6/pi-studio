import assert from 'node:assert/strict';
import test from 'node:test';

const { QUOTA_EXTENSION_ID } = await import('../../web/src/types/provider-quota.ts');
const {
  EXTENSION_PICKER_SEARCH_THRESHOLD,
  describeExtensionPickerEntry,
  filterExtensionPickerEntries,
} = await import('../../web/src/features/extensions/extension-picker-model.ts');

function panel(extensionId, extensionName, contributionId = 'main', extra = {}) {
  return {
    id: `${extensionId}:${contributionId}`,
    extensionId,
    extensionName,
    contributionId,
    slot: 'panel.side',
    title: extra.title ?? extensionName,
    description: extra.description,
    content: extra.content ?? [],
  };
}

function summary(extensionId, details, content = [{ kind: 'text', text: 'live' }]) {
  return {
    id: `${extensionId}:summary`,
    extensionId,
    extensionName: extensionId,
    contributionId: 'summary',
    slot: 'conversation.header',
    title: extensionId,
    details,
    content,
  };
}

test('classifies live-summary cards separately from compact plain panels and exposes extra panels', () => {
  const plain = describeExtensionPickerEntry({ panels: [panel('ext.board', '任务看板', 'board', { description: '看板' })] }, false);
  assert.equal(plain.hasLiveSummary, false);
  assert.equal(plain.extraPanels.length, 0);

  const live = describeExtensionPickerEntry({
    panels: [panel('builtin:studio-metrics', 'Studio 指标')],
    summary: summary('builtin:studio-metrics', 'main'),
  }, false);
  assert.equal(live.hasLiveSummary, true);

  const quotaWithoutSource = describeExtensionPickerEntry({
    panels: [panel(QUOTA_EXTENSION_ID, '额度状态')],
    summary: summary(QUOTA_EXTENSION_ID, 'main', []),
  }, false);
  assert.equal(quotaWithoutSource.hasLiveSummary, false);

  const quotaWithSource = describeExtensionPickerEntry({
    panels: [panel(QUOTA_EXTENSION_ID, '额度状态')],
    summary: summary(QUOTA_EXTENSION_ID, 'main', []),
  }, true);
  assert.equal(quotaWithSource.hasLiveSummary, true);

  const multi = describeExtensionPickerEntry({
    panels: [
      panel('ext.suite', '套件', 'overview', { title: '总览' }),
      panel('ext.suite', '套件', 'logs', { title: '日志' }),
    ],
  }, false);
  assert.equal(multi.primaryPanel.contributionId, 'overview');
  assert.deepEqual(multi.extraPanels.map(item => item.contributionId), ['logs']);
});

test('filterExtensionPickerEntries preserves display order and supports multi-term search across name, panels and descriptions', () => {
  const groups = [
    { panels: [panel('ext.a', '任务看板', 'main', { description: '跨工作区任务管理' })] },
    { panels: [panel('ext.b', 'Excalidraw', 'canvas', { title: '实时画布', description: '手绘架构图' })] },
    {
      panels: [
        panel('ext.c', '数据库助手', 'tables', { title: '数据表' }),
        panel('ext.c', '数据库助手', 'query', { title: 'SQL 控制台', description: '只读查询' }),
      ],
    },
  ];

  assert.equal(EXTENSION_PICKER_SEARCH_THRESHOLD, 6);
  assert.deepEqual(
    filterExtensionPickerEntries(groups, '', false).map(item => item.primaryPanel.extensionId),
    ['ext.a', 'ext.b', 'ext.c'],
  );
  assert.deepEqual(
    filterExtensionPickerEntries(groups, '画布 架构', false).map(item => item.primaryPanel.extensionId),
    ['ext.b'],
  );
  assert.deepEqual(
    filterExtensionPickerEntries(groups, 'sql 只读', false).map(item => item.primaryPanel.extensionId),
    ['ext.c'],
  );
  assert.equal(filterExtensionPickerEntries(groups, '不存在的扩展', false).length, 0);
});
