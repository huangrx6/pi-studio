'use strict';

/**
 * Custom Electron protocol (`pi-ext://`) serving static frontend bundles from
 * installed, trusted extensions' `ui/` directories.
 */

const fs = require('node:fs');
const { protocol } = require('electron');
const {
  EXTENSION_VIEW_SCHEME,
  extensionViewContentSecurityPolicy,
  parseExtensionViewUrl,
  resolveExtensionViewAsset,
} = require('../core/extension-view.cjs');
const { extensionViewDirectory } = require('./studio-extensions.cjs');

let installed = false;

function registerExtensionViewProtocol() {
  if (installed) return;
  installed = true;
  protocol.handle(EXTENSION_VIEW_SCHEME, async (request) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      const { extensionId, relativePath } = parseExtensionViewUrl(request.url);
      const uiRoot = extensionViewDirectory(extensionId);
      if (!uiRoot) return new Response('Extension view unavailable', { status: 404 });
      const asset = resolveExtensionViewAsset(uiRoot, relativePath);
      const body = request.method === 'HEAD' ? null : await fs.promises.readFile(asset.filePath);
      const headers = {
        'Content-Type': asset.mimeType,
        'Content-Length': String(asset.size),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      };
      if (asset.mimeType.startsWith('text/html')) {
        headers['Content-Security-Policy'] = extensionViewContentSecurityPolicy();
      }
      return new Response(body, { status: 200, headers });
    } catch {
      return new Response('Extension asset not found', { status: 404 });
    }
  });
}

module.exports = { registerExtensionViewProtocol };
