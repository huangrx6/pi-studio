#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputFile = path.join(repositoryRoot, 'schemas', 'pi-studio.extension.schema.json');

const id = { $ref: '#/$defs/id' };
const contributionId = { $ref: '#/$defs/contributionId' };
const content = { $ref: '#/$defs/content' };
const packagePath = { $ref: '#/$defs/packagePath' };
const action = { $ref: '#/$defs/action' };
const tone = { $ref: '#/$defs/tone' };
const noticeTone = { $ref: '#/$defs/noticeTone' };
const density = { $ref: '#/$defs/density' };
const status = { $ref: '#/$defs/status' };
const chartTone = { $ref: '#/$defs/chartTone' };
const buttonTone = { $ref: '#/$defs/buttonTone' };
const permissions = { $ref: '#/$defs/permission' };

function text(maxLength, minLength = 0) {
  return {
    type: 'string',
    ...(minLength ? { minLength } : {}),
    maxLength,
  };
}

function array(items, maximum, minimum = 0) {
  return {
    type: 'array',
    ...(minimum ? { minItems: minimum } : {}),
    maxItems: maximum,
    items,
  };
}

function object(properties, required = Object.keys(properties), extra = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    ...(required.length ? { required } : {}),
    properties,
    ...extra,
  };
}

function contentBlock(kind, properties, required = []) {
  return object({
    kind: { const: kind },
    ...properties,
  }, ['kind', ...required]);
}

const actionButton = object({
  id,
  label: text(120, 1),
  tone: buttonTone,
  action,
}, ['id', 'label', 'action']);

const metric = object({
  id,
  label: text(120, 1),
  value: { type: ['string', 'number'] },
  unit: text(32),
  detail: text(240),
  trend: object({
    direction: { enum: ['up', 'down', 'flat'] },
    label: text(80, 1),
    tone: { enum: ['neutral', 'positive', 'negative'] },
  }, ['direction', 'label']),
  tone,
}, ['id', 'label', 'value']);

const chartSeries = object({
  id,
  label: text(120, 1),
  values: array({ type: 'number' }, 256, 1),
  tone: chartTone,
}, ['id', 'label', 'values']);

const timelineItem = object({
  id,
  title: text(160, 1),
  detail: text(600),
  time: text(80),
  status,
}, ['id', 'title']);

const statusItem = object({
  id,
  label: text(160, 1),
  detail: text(600),
  status,
}, ['id', 'label']);

const contributors = {
  tools: array(object({
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      pattern: '^[A-Za-z0-9_.:-]+$',
    },
    description: text(600),
  }, ['name']), 256),
  commands: array(object({
    id,
    title: text(120, 1),
    description: text(1200),
    placement: { enum: ['composer', 'command-menu', 'session', 'workspace'] },
    argumentHint: text(120),
    icon: { $ref: '#/$defs/icon' },
    action,
  }, ['id', 'title']), 256),
  panels: array(object({
    id,
    title: text(120, 1),
    description: text(1200),
    slot: {
      enum: [
        'workspace.sidebar',
        'conversation.header',
        'conversation.detail',
        'conversation.footer',
        'composer.before',
        'settings.panel',
        'panel.side',
        'status.bar',
      ],
    },
    icon: { $ref: '#/$defs/icon' },
    size: { enum: ['compact', 'regular'] },
    priority: { type: 'integer', minimum: -1000, maximum: 1000 },
    content: array(content, 64),
  }, ['id', 'title', 'slot']), 256),
  settings: array(object({
    id,
    title: text(120, 1),
    description: text(1200),
    content: array(content, 64),
  }, ['id', 'title']), 256),
  composer: array(object({
    id,
    title: text(80, 1),
    description: text(1200),
    action: id,
    argumentHint: text(120),
    icon: { $ref: '#/$defs/icon' },
  }, ['id', 'title', 'action']), 16),
  dataSources: array(object({
    id,
    title: text(120, 1),
    description: text(1200),
  }, ['id', 'title']), 256),
};

const contentBlocks = [
  contentBlock('heading', {
    text: text(400, 1),
    level: { enum: [2, 3] },
  }, ['text']),
  contentBlock('text', {
    text: text(8000, 1),
  }, ['text']),
  contentBlock('divider', {}),
  contentBlock('list', {
    items: array(object({
      title: text(200),
      text: text(2000, 1),
    }, ['text']), 32, 1),
  }, ['items']),
  contentBlock('keyValue', {
    items: array(object({
      label: text(200, 1),
      value: text(2000, 1),
    }, ['label', 'value']), 32, 1),
  }, ['items']),
  contentBlock('notice', {
    tone: noticeTone,
    title: text(200),
    text: text(4000, 1),
  }, ['text']),
  contentBlock('actions', {
    buttons: array(actionButton, 12, 1),
  }, ['buttons']),
  contentBlock('badge', {
    label: text(120, 1),
    tone,
  }, ['label']),
  contentBlock('emptyState', {
    title: text(160, 1),
    text: text(800),
    action: actionButton,
  }, ['title']),
  contentBlock('section', {
    title: text(160),
    description: text(600),
    tone,
    density,
    content: array(content, 64),
  }, ['content']),
  contentBlock('stack', {
    gap: density,
    content: array(content, 64),
  }, ['content']),
  contentBlock('grid', {
    columns: { enum: [1, 2, 3, 4] },
    density,
    content: array(content, 64),
  }, ['content']),
  contentBlock('tabs', {
    activeTab: id,
    tabs: array(object({
      id,
      label: text(80, 1),
      content: array(content, 64),
    }, ['id', 'label', 'content']), 8, 1),
  }, ['tabs']),
  contentBlock('disclosure', {
    title: text(160, 1),
    description: text(600),
    open: { type: 'boolean' },
    content: array(content, 64),
  }, ['title', 'content']),
  contentBlock('metric', {
    id,
    label: text(120, 1),
    value: { type: ['string', 'number'] },
    unit: text(32),
    detail: text(240),
    trend: { $ref: '#/$defs/metricTrend' },
    tone,
  }, ['id', 'label', 'value']),
  contentBlock('metricGrid', {
    columns: { enum: [1, 2, 3, 4] },
    metrics: array({ $ref: '#/$defs/metric' }, 24, 1),
  }, ['metrics']),
  contentBlock('sparkline', {
    label: text(160, 1),
    values: array({ type: 'number' }, 256, 1),
    unit: text(32),
    tone: chartTone,
  }, ['label', 'values']),
  contentBlock('chart', {
    title: text(160, 1),
    description: text(600),
    labels: array(text(80), 256),
    series: array({ $ref: '#/$defs/chartSeries' }, 4, 1),
    unit: text(32),
  }, ['title', 'series']),
  contentBlock('timeline', {
    title: text(160),
    items: array({ $ref: '#/$defs/timelineItem' }, 64, 1),
  }, ['items']),
  contentBlock('statusList', {
    title: text(160),
    items: array({ $ref: '#/$defs/statusItem' }, 64, 1),
  }, ['items']),
  contentBlock('table', {
    title: text(160),
    columns: array(object({
      key: id,
      label: text(120, 1),
      align: { enum: ['left', 'right', 'center'] },
    }, ['key', 'label']), 12, 1),
    rows: array({
      type: 'object',
      maxProperties: 12,
      additionalProperties: {
        type: ['string', 'number', 'boolean', 'null'],
      },
    }, 200),
  }, ['columns', 'rows']),
  contentBlock('progress', {
    label: text(160, 1),
    value: { type: 'number' },
    max: { type: 'number', exclusiveMinimum: 0 },
    detail: text(240),
    tone: chartTone,
  }, ['label', 'value']),
  contentBlock('dataView', {
    sourceId: contributionId,
    emptyText: text(160),
    fallback: array(content, 64),
  }, ['sourceId']),
];

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://pi.studio/schemas/pi-studio.extension.schema.json',
  title: 'Pi Studio Extension Manifest',
  description: 'Distribution and runtime manifest for Agent and UI extensions hosted by Pi Studio.',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'id', 'name', 'version', 'permissions', 'contributes'],
  properties: {
    $schema: text(2000),
    format: { const: 1 },
    id: {
      type: 'string',
      minLength: 2,
      maxLength: 64,
      pattern: '^[a-z0-9][a-z0-9._-]+$',
    },
    name: text(120, 1),
    version: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$',
    },
    description: text(1200),
    author: text(160, 1),
    publisher: text(80, 1),
    license: {
      type: 'string',
      maxLength: 64,
      pattern: '^[A-Za-z0-9][A-Za-z0-9.+\\-]*$',
    },
    repository: {
      type: 'string',
      maxLength: 2000,
      format: 'uri',
      pattern: '^https://',
    },
    homepage: {
      type: 'string',
      maxLength: 2000,
      format: 'uri',
      pattern: '^https://',
    },
    engines: object({
      piStudio: { type: 'string', minLength: 1, maxLength: 120 },
    }, []),
    keywords: {
      type: 'array',
      uniqueItems: true,
      maxItems: 12,
      items: text(32, 1),
    },
    icon: packagePath,
    readme: packagePath,
    tier: {
      description: 'Studio internal ownership tier. User and project packages must omit this field; the host rejects it.',
      enum: ['core', 'system', 'optional', 'user', 'project'],
    },
    requires: {
      type: 'array',
      uniqueItems: true,
      maxItems: 64,
      items: { $ref: '#/$defs/extensionId' },
    },
    permissions: {
      type: 'array',
      uniqueItems: true,
      maxItems: 16,
      items: permissions,
    },
    providerAccess: {
      description: 'Exact Studio provider IDs readable through the provider.credentials capability.',
      type: 'array',
      uniqueItems: true,
      maxItems: 64,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        pattern: '^[a-z0-9][a-z0-9._-]*$',
      },
    },
    runtime: object({
      durableEntry: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        pattern: '\\.(?:mjs|js)$',
      },
    }, ['durableEntry']),
    contributes: object(contributors, []),
  },
  allOf: [
    {
      description: 'Distribution packages require a publisher or an author that becomes the publisher.',
      anyOf: [
        { required: ['publisher'] },
        { required: ['author'] },
      ],
    },
    {
      description: 'Agent capabilities require a Durable entry.',
      if: {
        properties: {
          permissions: { contains: { pattern: '^agent\\.' } },
        },
        required: ['permissions'],
      },
      then: { required: ['runtime'] },
    },
    {
      description: 'Runtime code is only useful with Agent, command or data-view capabilities.',
      if: { required: ['runtime'] },
      then: {
        properties: {
          permissions: {
            contains: {
              enum: [
                'agent.tools',
                'agent.sections',
                'agent.hooks',
                'agent.tasks',
                'provider.credentials',
                'ui.commands',
                'ui.data',
              ],
            },
          },
        },
        required: ['permissions'],
      },
    },
    {
      description: 'Tools require agent.tools.',
      if: {
        properties: {
          contributes: {
            properties: {
              tools: { minItems: 1 },
            },
            required: ['tools'],
          },
        },
        required: ['contributes'],
      },
      then: {
        properties: {
          permissions: { contains: { const: 'agent.tools' } },
        },
        required: ['permissions'],
      },
    },
    {
      description: 'Command and composer contributions require ui.commands.',
      if: {
        properties: {
          contributes: {
            anyOf: [
              { properties: { commands: { minItems: 1 } }, required: ['commands'] },
              { properties: { composer: { minItems: 1 } }, required: ['composer'] },
            ],
          },
        },
        required: ['contributes'],
      },
      then: {
        properties: {
          permissions: { contains: { const: 'ui.commands' } },
        },
        required: ['permissions'],
      },
    },
    {
      description: 'Panels require ui.panels.',
      if: {
        properties: {
          contributes: {
            properties: { panels: { minItems: 1 } },
            required: ['panels'],
          },
        },
        required: ['contributes'],
      },
      then: {
        properties: {
          permissions: { contains: { const: 'ui.panels' } },
        },
        required: ['permissions'],
      },
    },
    {
      description: 'Settings contributions require ui.settings.',
      if: {
        properties: {
          contributes: {
            properties: { settings: { minItems: 1 } },
            required: ['settings'],
          },
        },
        required: ['contributes'],
      },
      then: {
        properties: {
          permissions: { contains: { const: 'ui.settings' } },
        },
        required: ['permissions'],
      },
    },
    {
      description: 'Data sources require ui.data and a Durable entry.',
      if: {
        properties: {
          contributes: {
            properties: { dataSources: { minItems: 1 } },
            required: ['dataSources'],
          },
        },
        required: ['contributes'],
      },
      then: {
        properties: {
          permissions: { contains: { const: 'ui.data' } },
        },
        required: ['permissions', 'runtime'],
      },
    },
    {
      description: 'ui.data requires at least one declared data source.',
      if: {
        properties: {
          permissions: { contains: { const: 'ui.data' } },
        },
        required: ['permissions'],
      },
      then: {
        properties: {
          contributes: {
            properties: { dataSources: { minItems: 1 } },
            required: ['dataSources'],
          },
        },
        required: ['contributes'],
      },
    },
    {
      description: 'provider.credentials requires a Durable entry and exact provider access.',
      if: {
        properties: {
          permissions: { contains: { const: 'provider.credentials' } },
        },
        required: ['permissions'],
      },
      then: {
        properties: {
          runtime: { type: 'object' },
          providerAccess: { minItems: 1 },
        },
        required: ['runtime', 'providerAccess'],
      },
    },
    {
      description: 'providerAccess requires provider.credentials.',
      if: {
        properties: { providerAccess: { minItems: 1 } },
        required: ['providerAccess'],
      },
      then: {
        properties: {
          permissions: { contains: { const: 'provider.credentials' } },
        },
        required: ['permissions'],
      },
    },
  ],
  $defs: {
    extensionId: {
      type: 'string',
      maxLength: 120,
      pattern: '^(?:builtin|user|project):[a-z0-9][a-z0-9._-]{1,63}$',
    },
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[a-z0-9][a-z0-9._-]*$',
    },
    contributionId: {
      type: 'string',
      maxLength: 220,
      pattern: '^(?:builtin|user|project):[a-z0-9][a-z0-9._-]{1,63}/[a-z0-9][a-z0-9._-]{0,63}$',
    },
    contributionRef: {
      oneOf: [
        contributionId,
        id,
      ],
    },
    icon: {
      type: 'string',
      maxLength: 96,
      pattern: '^[a-z0-9][a-z0-9._/-]*$',
    },
    packagePath: {
      type: 'string',
      minLength: 1,
      maxLength: 240,
      pattern: '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*\\\\).+$',
    },
    permission: {
      enum: [
        'agent.tools',
        'agent.sections',
        'agent.hooks',
        'agent.tasks',
        'ui.commands',
        'ui.panels',
        'ui.settings',
        'ui.data',
        'provider.credentials',
        'network',
      ],
    },
    tone: { enum: ['neutral', 'info', 'success', 'warning', 'error'] },
    noticeTone: { enum: ['info', 'success', 'warning', 'error'] },
    density: { enum: ['compact', 'comfortable', 'spacious'] },
    status: { enum: ['pending', 'active', 'success', 'warning', 'error', 'neutral'] },
    chartTone: { enum: ['accent', 'info', 'success', 'warning', 'error'] },
    buttonTone: { enum: ['default', 'primary', 'danger'] },
    metricTrend: object({
      direction: { enum: ['up', 'down', 'flat'] },
      label: text(80, 1),
      tone: { enum: ['neutral', 'positive', 'negative'] },
    }, ['direction', 'label']),
    metric,
    chartSeries,
    timelineItem,
    statusItem,
    action: {
      oneOf: [
        object({
          kind: { const: 'openSettings' },
          panel: {
            enum: [
              'general',
              'tools',
              'harness',
              'subagents',
              'permissions',
              'models',
              'usage',
              'mcp',
              'skills',
              'extensions',
              'about',
            ],
          },
        }, ['kind']),
        object({
          kind: { const: 'openPanel' },
          panelId: { $ref: '#/$defs/contributionRef' },
        }, ['kind', 'panelId']),
        object({
          kind: { const: 'sendPrompt' },
          text: text(100000, 1),
          submit: { type: 'boolean' },
        }, ['kind', 'text']),
        object({
          kind: { const: 'copyText' },
          text: text(100000, 1),
        }, ['kind', 'text']),
        object({
          kind: { const: 'openUrl' },
          url: {
            type: 'string',
            maxLength: 2000,
            pattern: '^https?://',
          },
        }, ['kind', 'url']),
        object({
          kind: { const: 'runCommand' },
          commandId: { $ref: '#/$defs/contributionRef' },
        }, ['kind', 'commandId']),
      ],
    },
    content: {
      oneOf: contentBlocks,
    },
  },
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(schema, null, 2)}\n`);
process.stdout.write(`${path.relative(repositoryRoot, outputFile)}\n`);
