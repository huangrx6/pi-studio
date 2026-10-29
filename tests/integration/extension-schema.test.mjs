import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeContentList,
} from '../../electron/services/studio-extension-ui.cjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, 'schemas', 'pi-studio.extension.schema.json'),
  'utf8',
));
const authoringTypes = fs.readFileSync(
  path.join(repositoryRoot, 'types', 'pi-studio-extension-authoring.d.ts'),
  'utf8',
);

const minimalBlocks = {
  heading: { kind: 'heading', text: 'Heading' },
  text: { kind: 'text', text: 'Text' },
  divider: { kind: 'divider' },
  list: { kind: 'list', items: [{ text: 'Item' }] },
  keyValue: { kind: 'keyValue', items: [{ label: 'Key', value: 'Value' }] },
  notice: { kind: 'notice', text: 'Notice' },
  actions: {
    kind: 'actions',
    buttons: [{
      id: 'open',
      label: 'Open',
      action: { kind: 'openSettings', panel: 'extensions' },
    }],
  },
  badge: { kind: 'badge', label: 'Badge' },
  emptyState: { kind: 'emptyState', title: 'Empty' },
  section: { kind: 'section', content: [] },
  stack: { kind: 'stack', content: [] },
  grid: { kind: 'grid', content: [] },
  tabs: {
    kind: 'tabs',
    tabs: [{ id: 'main', label: 'Main', content: [] }],
  },
  disclosure: { kind: 'disclosure', title: 'More', content: [] },
  metric: { kind: 'metric', id: 'latency', label: 'Latency', value: 12 },
  metricGrid: {
    kind: 'metricGrid',
    metrics: [{ id: 'latency', label: 'Latency', value: 12 }],
  },
  sparkline: { kind: 'sparkline', label: 'Trend', values: [1, 2] },
  chart: {
    kind: 'chart',
    title: 'Chart',
    series: [{ id: 'main', label: 'Main', values: [1, 2] }],
  },
  timeline: {
    kind: 'timeline',
    items: [{ id: 'step', title: 'Step', status: 'active' }],
  },
  statusList: {
    kind: 'statusList',
    items: [{ id: 'service', label: 'Service', status: 'success' }],
  },
  table: {
    kind: 'table',
    columns: [{ key: 'name', label: 'Name' }],
    rows: [{ name: 'Pi' }],
  },
  progress: { kind: 'progress', label: 'Progress', value: 4, max: 10 },
  dataView: { kind: 'dataView', sourceId: 'user:test/live' },
};

test('JSON Schema keeps recursive content blocks inside $defs.content', () => {
  const schemaKinds = schema.$defs.content.oneOf
    .map((block) => block.properties.kind.const)
    .sort();
  assert.deepEqual(schemaKinds, Object.keys(minimalBlocks).sort());
  assert.equal(schema.allOf.some((entry) => entry.properties?.kind), false);
  assert.equal(schema.properties.permissions.items.$ref, '#/$defs/permission');
  assert.equal(schema.$defs.permission.enum.includes('ui.data'), true);
  assert.equal(schema.properties.tier.enum.includes('optional'), true);
});

test('every schema content block is accepted by the runtime normalizer', () => {
  const normalized = normalizeContentList(
    Object.values(minimalBlocks),
    { manifestId: 'test', scope: 'user' },
    (raw) => raw,
  );
  assert.deepEqual(normalized.map((block) => block.kind), Object.keys(minimalBlocks));
});

test('authoring declarations cover the complete public author surface', () => {
  for (const token of [
    "'ui.data'",
    "'optional'",
    'publisher',
    'license',
    'repository',
    'homepage',
    'engines',
    'keywords',
    'dataSources',
    'apiVersion',
    'extensionId',
    'manifestId',
    'dataDirectory',
    'durableExtension',
    'PiStudioExtensionCommandHandler',
    'PiStudioExtensionDataSourceProvider',
    'activate',
  ]) {
    assert.match(authoringTypes, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
