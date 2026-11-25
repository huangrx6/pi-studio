'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_BYTES = 64 * 1024;

function readPluginIcon(root, relative, containingRoot = root) {
  if (!root || typeof relative !== 'string' || !/\.png$/i.test(relative) || path.isAbsolute(relative)
    || relative.split(/[/\\]/).includes('..')) return '';
  try {
    const base = fs.realpathSync(root);
    const containingBase = fs.realpathSync(containingRoot);
    if (base !== containingBase && !base.startsWith(`${containingBase}${path.sep}`)) return '';
    const file = fs.realpathSync(path.resolve(base, relative));
    if (!file.startsWith(`${base}${path.sep}`)) return '';
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 33 || stat.size > MAX_BYTES) return '';
    const bytes = fs.readFileSync(file);
    if (bytes.length < 33 || bytes.length > MAX_BYTES || !bytes.subarray(0, 8).equals(PNG)
      || bytes.toString('ascii', 12, 16) !== 'IHDR') return '';
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (!width || !height || width > 512 || height > 512) return '';
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return '';
  }
}

module.exports = { readPluginIcon };
