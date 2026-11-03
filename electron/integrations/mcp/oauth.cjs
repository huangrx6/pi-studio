/**
 * Pi MCP OAuth with Studio-owned encrypted state.
 *
 * The OAuth state contains client registration, PKCE verifier, discovery and
 * tokens. It is stored in SQLite only as a safeStorage envelope and never
 * returned to the renderer.
 */

const { getStudioDatabase } = require('../../core/studio-db.cjs');
const { app } = require('electron');

const OAUTH_TIMEOUT_MS = 5 * 60_000;
const STUDIO_VERSION = typeof app?.getVersion === 'function'
  ? app.getVersion()
  : require('../../../package.json').version;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function expandEnvironmentValue(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`MCP OAuth 引用的环境变量 ${name} 未设置`);
    return resolved;
  });
}

function expandOAuthHeaders(headers = {}) {
  const expanded = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = String(rawKey).trim();
    if (!key || typeof rawValue !== 'string') continue;
    try {
      expanded[key] = expandEnvironmentValue(rawValue);
    } catch (error) {
      throw new Error(`Header ${key}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return expanded;
}

function stateStore(serverUrl) {
  const db = getStudioDatabase();
  return {
    load() {
      return db.readMcpOAuthState(serverUrl);
    },
    save(value) {
      db.writeMcpOAuthState(serverUrl, value);
    },
  };
}

function clientMetadata() {
  return {
    client_name: 'Pi Studio',
    client_uri: 'https://github.com/huangrx6/pi-studio',
    software_id: 'dev.pi.studio',
    software_version: STUDIO_VERSION,
  };
}

async function runtimeOAuthProvider(serverUrl) {
  const oauth = await import('@earendil-works/pi-mcp/oauth');
  return new oauth.McpOAuthProvider({
    serverUrl,
    // This redirect URL is used only for a new authorization. Normal requests
    // and token refresh consume the encrypted stored state.
    redirectUrl: 'http://127.0.0.1/pi-studio/oauth/callback',
    clientMetadata: clientMetadata(),
    store: stateStore(serverUrl),
    onRedirect() {
      // Runtime connections never launch a browser implicitly. A 401 surfaces
      // in settings, where the user can explicitly start the OAuth flow.
    },
  });
}

async function authorizeMcpServer(server, openExternal) {
  if (server?.transport !== 'http' || typeof server.url !== 'string' || !server.url) {
    throw new Error('只有 HTTP MCP 服务器可以使用 OAuth 登录');
  }
  const oauth = await import('@earendil-works/pi-mcp/oauth');
  const mcp = await import('@earendil-works/pi-mcp');
  const headers = expandOAuthHeaders(server.headers);
  const callback = await oauth.OAuthCallbackServer.listen({
    host: '127.0.0.1',
    timeoutMs: OAUTH_TIMEOUT_MS,
    renderPage(page) {
      const title = page.ok ? 'Pi Studio 已连接' : 'Pi Studio 登录未完成';
      const detail = page.ok
        ? '可以关闭这个页面并返回 Pi Studio。'
        : escapeHtml(page.message || '授权服务器没有返回可用凭据。');
      return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#101010;color:#ededed}main{max-width:520px;padding:36px}strong{display:block;font-size:22px;margin-bottom:8px}p{color:#b8b8b8}</style><main><strong>${title}</strong><p>${detail}</p></main></html>`;
    },
  });
  let authorizationUrl;
  const provider = new oauth.McpOAuthProvider({
    serverUrl: server.url,
    redirectUrl: callback.redirectUrl,
    clientMetadata: clientMetadata(),
    store: stateStore(server.url),
    onRedirect(url) {
      authorizationUrl = url;
    },
  });
  const client = new mcp.McpClient({
    name: 'Pi Studio OAuth',
    version: '1.0.0',
    requestTimeoutMs: Math.max(1, Number(server.timeoutSeconds) || 60) * 1_000,
  });
  const transport = new mcp.StreamableHttpTransport({
    url: server.url,
    headers,
    authProvider: oauth.adaptOAuthProvider(provider),
  });
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      if (!(error instanceof oauth.McpOAuthAuthorizationRequiredError)) throw error;
    }
    if (!authorizationUrl) {
      const result = await oauth.authorizeMcp(provider, {
        serverUrl: server.url,
        skipRefresh: true,
      });
      if (result !== 'REDIRECT' || !authorizationUrl) {
        throw new Error('授权服务器没有返回登录地址');
      }
    }
    const state = await provider.state();
    const pending = callback.waitForCallback(state);
    // Closing the callback after a browser-launch failure rejects this wait.
    // Observe it immediately so cleanup cannot create an unhandled rejection.
    pending.catch(() => {});
    await openExternal(authorizationUrl.toString());
    const response = await pending;
    await oauth.authorizeMcp(provider, {
      serverUrl: server.url,
      authorizationCode: response.code,
      ...(response.iss ? { iss: response.iss } : {}),
    });
    return {
      ok: true,
      serverUrl: server.url,
      authorizedAt: Date.now(),
    };
  } finally {
    await Promise.allSettled([
      callback.close(),
      typeof client.close === 'function' ? client.close() : Promise.resolve(),
      typeof transport.close === 'function' ? transport.close() : Promise.resolve(),
    ]);
  }
}

function clearMcpOAuth(serverUrl) {
  getStudioDatabase().deleteMcpOAuthState(serverUrl);
}

module.exports = {
  authorizeMcpServer,
  clearMcpOAuth,
  expandOAuthHeaders,
  runtimeOAuthProvider,
  stateStore,
};
