'use strict';

const MAX_SCENE_BYTES = 8 * 1024 * 1024;
const MAX_ELEMENTS = 1_000;
const ELEMENT_TYPES = new Set([
  'rectangle', 'diamond', 'ellipse', 'text', 'arrow', 'line', 'freedraw', 'frame', 'image',
]);
const ELEMENT_FIELDS = [
  'id', 'type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor',
  'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'groupIds', 'frameId',
  'index', 'roundness', 'seed', 'version', 'versionNonce', 'isDeleted', 'boundElements', 'updated',
  'locked', 'fontSize', 'fontFamily', 'text', 'originalText', 'textAlign', 'verticalAlign',
  'containerId', 'autoResize', 'lineHeight', 'points', 'startBinding', 'endBinding', 'startArrowhead',
  'endArrowhead', 'elbowed', 'fixedSegments', 'startIsSpecial', 'endIsSpecial', 'pressures',
  'simulatePressure', 'lastCommittedPoint', 'fileId', 'status', 'scale', 'crop', 'name',
];
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const COLOR = /^(?:#[\da-f]{3}(?:[\da-f]|[\da-f]{3}(?:[\da-f]{2})?)?|transparent)$/i;
const IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const NUMBER_FIELDS = new Set(['angle', 'strokeWidth', 'roughness', 'opacity', 'seed', 'version', 'versionNonce', 'updated', 'fontSize', 'fontFamily', 'lineHeight']);
const BOOLEAN_FIELDS = new Set(['isDeleted', 'locked', 'autoResize', 'elbowed', 'startIsSpecial', 'endIsSpecial', 'simulatePressure']);
const STRING_FIELDS = new Set([
  'fillStyle', 'strokeStyle', 'frameId', 'index', 'text', 'originalText', 'textAlign',
  'verticalAlign', 'containerId', 'startArrowhead', 'endArrowhead', 'fileId', 'status', 'name',
]);

function object(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function coordinate(value) {
  return Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function boundedValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 32_000;
  if (depth >= 5) return false;
  if (Array.isArray(value)) return value.length <= 16_000 && value.every(item => boundedValue(item, depth + 1));
  return object(value) && Object.keys(value).length <= 16
    && Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key)
      && boundedValue(item, depth + 1));
}

function validElementField(type, name, value) {
  if (!boundedValue(value)) return false;
  if (NUMBER_FIELDS.has(name)) return typeof value === 'number';
  if (BOOLEAN_FIELDS.has(name)) return typeof value === 'boolean';
  if (STRING_FIELDS.has(name)) return value === null || typeof value === 'string';
  if (name === 'points') return Array.isArray(value) && value.length >= (type === 'freedraw' ? 1 : 2)
    && value.every(point => Array.isArray(point) && point.length === 2 && point.every(coordinate));
  if (name === 'groupIds') return Array.isArray(value) && value.every(id => typeof id === 'string' && ID.test(id));
  if (name === 'boundElements') return value === null || (Array.isArray(value)
    && value.every(item => object(item) && typeof item.id === 'string' && ID.test(item.id)
      && (item.type === 'text' || item.type === 'arrow')));
  return true;
}

function normalizeCanvasScene(raw) {
  if (!object(raw) || !Array.isArray(raw.elements) || raw.elements.length > MAX_ELEMENTS
    || Buffer.byteLength(JSON.stringify(raw)) > MAX_SCENE_BYTES) {
    throw new Error('画布文件过大或格式无效（最多 1000 个元素、8 MB）');
  }
  const ids = new Set();
  const elements = raw.elements.map(element => {
    if (!object(element) || typeof element.id !== 'string' || !ID.test(element.id) || ids.has(element.id)
      || !ELEMENT_TYPES.has(element.type) || ![element.x, element.y, element.width, element.height].every(coordinate)
      || element.width < 0 || element.height < 0) {
      throw new Error('画布包含不支持的元素类型、重复 ID 或无效坐标');
    }
    ids.add(element.id);
    const clean = {};
    for (const field of ELEMENT_FIELDS) {
      const value = element[field];
      if (value === undefined) continue;
      if (!validElementField(element.type, field, value)) throw new Error(`画布元素字段无效：${field}`);
      clean[field] = value;
    }
    for (const field of ['strokeColor', 'backgroundColor']) {
      if (clean[field] !== undefined && (typeof clean[field] !== 'string' || !COLOR.test(clean[field]))) {
        throw new Error('画布颜色必须使用十六进制色值或 transparent');
      }
    }
    return clean;
  });
  const files = Object.create(null);
  const supplied = object(raw.files) ? raw.files : {};
  const usedImages = new Set(elements.filter(element => element.type === 'image' && element.fileId)
    .map(element => element.fileId));
  for (const id of usedImages) {
    if (typeof id !== 'string' || !ID.test(id) || !Object.hasOwn(supplied, id)) {
      throw new Error('画布缺少嵌入图片');
    }
    const file = supplied[id];
    if (!object(file) || typeof file.dataURL !== 'string' || !IMAGE.test(file.dataURL)) {
      throw new Error('画布图片必须是内嵌的 PNG、JPEG、WebP 或 GIF');
    }
    const mimeType = file.dataURL.slice(5, file.dataURL.indexOf(';'));
    files[id] = { id, mimeType, dataURL: file.dataURL, created: Number.isFinite(file.created) ? file.created : 0 };
  }
  const viewBackgroundColor = raw.appState?.viewBackgroundColor;
  return {
    elements,
    files: { ...files },
    ...(typeof viewBackgroundColor === 'string' && COLOR.test(viewBackgroundColor)
      ? { appState: { viewBackgroundColor } } : {}),
  };
}

function normalizeCanvasSnapshot(raw) {
  if (!object(raw) || !Number.isSafeInteger(raw.revision) || raw.revision < 0) {
    throw new Error('画布数据源返回了无效版本');
  }
  const scene = normalizeCanvasScene(raw.scene);
  let playback;
  if (raw.playback !== undefined) {
    if (!object(raw.playback) || raw.drawing !== true) {
      throw new Error('画布播放状态无效');
    }
    const { startAt, durationMs, firstElement } = raw.playback;
    if (!Number.isSafeInteger(startAt) || startAt < 0
      || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 30_000
      || !Number.isInteger(firstElement) || firstElement < 0 || firstElement >= scene.elements.length) {
      throw new Error('画布播放时长或元素范围无效');
    }
    playback = { startAt, durationMs, firstElement };
  }
  return {
    scene,
    revision: raw.revision,
    drawing: raw.drawing === true,
    title: typeof raw.title === 'string' ? raw.title.trim().slice(0, 120) : '',
    ...(playback ? { playback } : {}),
  };
}

module.exports = { normalizeCanvasScene, normalizeCanvasSnapshot, MAX_SCENE_BYTES };
