import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function launchTestDesktop(workspace, profile, width, height) {
  const env = { ...process.env, PI_WORKSPACE: workspace, PI_STUDIO_USER_DATA: profile, PI_STUDIO_DB: path.join(profile, 'studio.sqlite') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PI_STUDIO_DEV;
  const app = await _electron.launch({ args: [root, '--disable-background-networking', '--use-mock-keychain'], cwd: workspace, env });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height]);
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => !!window.piApi?.createConversation);
    return { app, page };
  } catch (error) {
    await app.close();
    throw error;
  }
}

export async function configureTestModel(page, cwd, baseUrl) {
  await page.evaluate(async ({ baseUrl, cwd }) => {
    const api = window.piApi, providerId = 'desktop-qa', ref = providerId + '/check';
    await api.addProvider({ cwd, providerId, name: '验收模型', api: 'openai-completions', baseUrl, apiKey: 'local-test-only' });
    await api.addCustomModel({ cwd, providerId, modelId: 'check', name: '验收模型', contextWindow: 64000, maxTokens: 1024 });
    await api.setEnabledModels({ cwd, models: [ref] });
    await api.setDefaultModel(ref, cwd);
  }, { baseUrl, cwd });
}

export async function selectTestSession(page, cwd, id) {
  const group = page.locator('[data-workspace-cwd="' + cwd + '"] .workspace-row');
  if (await group.getAttribute('aria-expanded') === 'false') await group.click();
  await page.locator('[data-session-id="' + id + '"] .session-row').click();
  await page.waitForFunction(id => document.querySelector('.session-row.is-active')?.closest('[data-session-id]')?.dataset.sessionId === id, id);
}
