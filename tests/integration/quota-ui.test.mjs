import assert from 'node:assert/strict';
import test from 'node:test';

import {
  quotaContent,
  quotaSummary,
} from '../../extensions/pi-quota-status/quota/ui.mjs';

function flatten(value) {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (!value || typeof value !== 'object') return [value];
  return [value, ...Object.values(value).flatMap(flatten)];
}

const adapter = {
  display: 'GLM Coding Plan',
  category: '套餐用量',
  endpoint: 'https://example.test/quota',
  note: 'test adapter',
};

const state = {
  loading: false,
  errorText: '',
  lastRefreshError: '',
  quotaFetchedAt: Date.now(),
  quotaData: {
    bars: [
      { kind: 'percentage', label: '5 小时', percent: 1, resetsInMs: 3_600_000 },
      { kind: 'percentage', label: '本周', percent: 11, resetsInMs: 86_400_000 },
    ],
  },
};

test('quota footer stays short and contains no controls or provenance labels', () => {
  assert.deepEqual(quotaSummary(state, adapter), [{
    kind: 'text',
    text: '5H 1% · W 11% · GLM',
  }]);

  const values = flatten(quotaContent(state, adapter));
  assert.ok(values.some((value) => value?.kind === 'metricGrid'));
  assert.equal(values.some((value) => value?.kind === 'actions'), false);
  assert.equal(values.includes('刷新额度'), false);
  assert.equal(values.includes('来源'), false);
  assert.equal(values.includes('更新时间'), false);
});

test('quota footer uses short loading and unavailable states', () => {
  assert.deepEqual(quotaSummary({
    ...state,
    loading: true,
    quotaData: null,
  }, adapter), [{
    kind: 'text',
    text: 'GLM · SYNC',
  }]);
  assert.deepEqual(quotaSummary(state, undefined), [{
    kind: 'text',
    text: 'QUOTA · —',
  }]);
});
