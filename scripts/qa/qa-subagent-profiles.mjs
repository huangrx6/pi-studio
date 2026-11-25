/** Real Electron settings, composer and Durable delegation against a loopback provider. */
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { configureTestModel, launchTestDesktop, selectTestSession } from './fixtures/isolated-desktop.mjs';

const output = fileURLToPath(new URL('../../.qa/subagent-roster/', import.meta.url));
const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-role-desktop-')));
const workspace = path.join(temp, 'workspace'), profile = path.join(temp, 'profile');
const alternateWorkspace = path.join(temp, '备用工作区');
const pluginDirectory = fileURLToPath(new URL('../../examples/plugins/toolkit-starter/', import.meta.url));
const childMarker = '按文件与行号列出评审意见。';
const report = { delegated: false, child: false, fileContext: false, skillBody: false, mcpMethod: false };
let childToolNames;
const model = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!req.url.endsWith('/chat/completions')) { res.end('{"data":[]}'); return; }
  const { messages, tools = [] } = JSON.parse(body);
  const systemText = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => JSON.stringify(m.content)).join(' ');
  const userText = messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content.map(c => c.text || '').join(' ')).join(' ');
  let delta, reason = 'stop';
  const match = /"profileId":"([a-f0-9-]{36})"/.exec(userText);
  const lastUser = messages.findLastIndex(message => message.role === 'user');
  if (JSON.stringify(messages[lastUser]?.content ?? '').includes('MCP_ROUNDTRIP') && tools.length) {
    const results = messages.slice(lastUser + 1).filter(message => message.role === 'tool');
    if (results.some(message => JSON.stringify(message.content).includes('STUDIO_ECHO_RECEIVED'))) {
      delta = { content: '已验证方法回传。' };
    } else if (results.length < 2) {
      const method = 'mcp__toolkit_demo__toolkit_echo';
      const direct = tools.some(tool => tool.function.name === method);
      delta = { tool_calls: [{ index: 0, id: direct ? 'echo-qa' : 'discover-qa', type: 'function', function: {
        name: direct ? method : 'tool_search', arguments: JSON.stringify(direct ? { text: 'STUDIO_ECHO_RECEIVED' } : { query: 'toolkit_echo' }),
      } }] };
      reason = 'tool_calls';
    } else delta = { content: '未能执行示例方法。' };
  } else if (match && tools.some(t => t.function.name === 'subagent') && !messages.some(m => m.role === 'tool')) {
    report.delegated = true;
    report.fileContext ||= userText.includes('ROLE_FILE_FIXTURE');
    report.skillBody ||= userText.includes('当用户想验证插件安装是否成功时，使用本技能。');
    report.mcpMethod ||= userText.includes('"tool":"mcp__toolkit_demo__toolkit_echo"');
    delta = { tool_calls: [{ index: 0, id: 'role-qa-call', type: 'function', function: {
      name: 'subagent', arguments: JSON.stringify({ action: 'run', mode: 'foreground', profileId: match[1], task: '审阅示例文件。' }),
    } }] };
    reason = 'tool_calls';
  } else if (systemText.includes(childMarker)) {
    report.child = true;
    childToolNames = tools.map(tool => tool.function.name);
    delta = { content: '子任务已完成审阅。' };
  } else {
    delta = { content: messages.some(m => m.role === 'tool') ? '已收到审阅结果。' : '示例文件评审' };
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (value, finish = null) => 'data: ' + JSON.stringify({ id: 'local-qa', model: 'check', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\n';
  res.end(frame({ role: 'assistant' }) + frame(delta) + frame({}, reason) + 'data: [DONE]\n\n');
});
await new Promise((resolve, reject) => model.once('error', reject).listen(0, '127.0.0.1', resolve));
let app, page;
try {
  await Promise.all([output, workspace, alternateWorkspace, profile].map(dir => mkdir(dir, { recursive: true })));
  await writeFile(path.join(workspace, 'README.md'), '# 示例\nROLE_FILE_FIXTURE\n');
  const skill = path.join(profile, 'skills', 'review-guide');
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: review-guide\ndescription: 项目文档审阅指南\n---\n按行核对项目文档。');
  ({ app, page } = await launchTestDesktop(workspace, profile, 1250, 870));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await configureTestModel(page, workspace, 'http://127.0.0.1:' + model.address().port + '/v1');
  await page.evaluate(async ({ source, cwd }) => {
    await window.piApi.addCustomModel({ cwd, providerId: 'desktop-qa', modelId: 'review', name: '审阅推理模型',
      reasoning: true, thinkingLevels: ['off', 'low', 'medium', 'high'], contextWindow: 64000, maxTokens: 1024 });
    await window.piApi.setEnabledModels({ cwd, models: ['desktop-qa/check', 'desktop-qa/review'] });
    const preview = await window.piApi.preparePluginInstall({ source });
    await window.piApi.installPlugin({ token: preview.token, cwd });
    await window.piApi.setMcpMethodEnabled({ server: 'toolkit-demo', method: 'toolkit_echo', enabled: true, cwd });
  }, { source: pluginDirectory, cwd: workspace });
  await page.evaluate(async cwd => {
    await window.piApi.setEnabledModels({ cwd, models: ['desktop-qa/check', 'desktop-qa/review'] });
    await window.piApi.createConversation({ cwd, title: '备用工作区验证' });
  }, alternateWorkspace);
  const id = await page.evaluate(async cwd => {
    const api = window.piApi;
    await api.setAgentTools({ cwd, tools: ['subagent', 'read', 'write', 'edit', 'bash', 'ls', 'find', 'grep'] });
    await api.permissionPolicySet({ scope: 'workspace', cwd, policy: { version: 1, preset: 'smart', default: 'ask',
      tools: { subagent: 'allow', tool_search: 'allow', mcp__toolkit_demo__toolkit_echo: 'allow' }, rules: [] } });
    return (await api.createConversation({ cwd })).id;
  }, workspace);
  await page.reload();
  await selectTestSession(page, workspace, id);
  const nav = page.locator('.settings-navigation');
  const open = name => nav.getByRole('button', { name, exact: true }).click();
  const roles = page.locator('.role-settings-page');
  const defaultsButton = roles.getByRole('button', { name: '共用运行默认值', exact: true });
  const defaults = page.getByRole('dialog', { name: '共用运行默认值', exact: true });
  const headerLayout = () => page.locator('.settings-content .settings-page-header').evaluate(header => {
    const title = header.querySelector('h1');
    const icon = header.querySelector('.settings-page-header-icon').getBoundingClientRect();
    return [title.getBoundingClientRect().left, getComputedStyle(title).font, icon.right, icon.width];
  });
  const settings = () => page.locator('.sidebar-bottom button[title="设置"]').click();
  const editor = page.getByRole('textbox', { name: '发送给 Pi 的消息' });
  const snap = name => page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
  const snapDialog = (dialog, name) => dialog.screenshot({ path: path.join(output, name + '.png'), scale: 'css', animations: 'disabled' });
  const checkActionButtons = async (root, names) => {
    for (const name of names) {
      const button = root.getByRole('button', { name, exact: true });
      const box = await button.boundingBox();
      assert.ok(box && Math.abs(box.height - 40) <= 1, JSON.stringify({ name, box }));
    }
  };
  const defaultActions = ['刷新子智能体配置', '关闭', '保存配置', '关闭弹框'];
  const editorActions = ['删除角色', '取消', '保存', '关闭弹框'];
  const confirmActions = ['关闭确认', '取消', '放弃更改'];
  const checkWidth = async (dialog, maxWidth) => {
    const size = await dialog.evaluate(node => {
      const body = node.querySelector('.dialog-body');
      return { dialog: node.offsetWidth, viewport: innerWidth, horizontalOverflow: body.scrollWidth - body.clientWidth };
    });
    assert.ok(size.dialog <= size.viewport - 46 && size.horizontalOverflow <= 1, JSON.stringify(size));
    if (maxWidth) assert.ok(Math.abs(size.dialog - Math.min(maxWidth, size.viewport - 48)) < 2, JSON.stringify(size));
  };
  const checkFieldLayout = async (dialog, narrow = false) => {
    const controls = ['角色名称', '何时使用', '角色指令'].map(name => dialog.getByRole('textbox', { name: new RegExp('^' + name) }));
    const buttons = ['更换头像', '角色模型', '角色默认思考强度', '角色工具权限', 'MCP 服务范围', '技能范围'];
    controls.push(...buttons.map(name => dialog.getByRole('button', { name, exact: true })));
    const fields = await Promise.all(controls.map(control => control.evaluate(node => {
      const { left, right, height, width } = node.getBoundingClientRect();
      return { left, right, height, width };
    })));
    const [name, when, instructions, avatar, model, thinking, tools, mcp, skills] = fields;
    const aligned = coords => Math.max(...coords) - Math.min(...coords) <= 1;
    assert.ok([name, when, avatar, model, thinking, tools, mcp, skills].every(field => Math.abs(field.height - 40) < 1), JSON.stringify(fields));
    assert.ok(aligned([avatar.right, when.right, instructions.right, thinking.right, tools.right, mcp.right, skills.right]), JSON.stringify(fields));
    if (narrow) {
      assert.ok(aligned([name.left, when.left, model.left, thinking.left]) && aligned([model.right, thinking.right]), JSON.stringify(fields));
    } else {
      assert.ok(aligned([name.left, when.left, instructions.left, model.left]) && aligned([name.right, model.right]));
      assert.ok(aligned([avatar.left, thinking.left, tools.left, mcp.left, skills.left]));
      assert.ok(name.width < instructions.width * 0.8 && thinking.width < model.width, 'short fields leave room for long text and model names');
    }
  };
  const checkNumberLayout = async dialog => {
    const fields = await dialog.locator('.role-number').evaluateAll(rows => rows.map(row => {
      const input = row.querySelector('input'), unit = row.querySelector('small'), reset = row.querySelector('button');
      const field = input.getBoundingClientRect(), suffix = unit.getBoundingClientRect(), button = reset?.getBoundingClientRect();
      return { name: input.id, height: field.height, width: field.width, unitGap: suffix.left - field.right,
        resetGap: button ? button.left - suffix.right : null, overflow: row.scrollWidth - row.clientWidth };
    }));
    assert.equal(fields.length, 6);
    for (const field of fields) {
      assert.ok(Math.abs(field.height - 40) < 1 && field.width >= 80, JSON.stringify(field));
      assert.ok(field.unitGap >= 0 && field.unitGap <= 16 && (field.resetGap === null || field.resetGap >= 0) && field.overflow <= 1, JSON.stringify(field));
    }
  };
  const checkBackdrop = dialog => dialog.evaluate(node => {
    const style = getComputedStyle(node, '::backdrop');
    return style.backdropFilter === 'blur(3px)' && !['transparent', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor);
  }).then(result => assert.ok(result, 'the full-window modal backdrop is visible and blurred'));
  const openMenu = async (dialog, label, click = trigger => trigger.click()) => {
    const trigger = dialog.getByRole('button', { name: label, exact: true });
    await click(trigger);
    const menu = dialog.getByRole('listbox', { name: label, exact: true });
    await menu.waitFor();
    const geometry = await menu.evaluate(async node => {
      await Promise.allSettled(node.getAnimations().map(animation => animation.finished));
      const button = [...node.closest('dialog').querySelectorAll('[aria-controls]')].find(el => el.getAttribute('aria-controls') === node.id);
      const a = button.getBoundingClientRect(), m = node.getBoundingClientRect();
      const o = node.querySelector('[role=option]:not(:disabled)').getBoundingClientRect();
      const body = button.closest('.dialog-body');
      const rightBound = body && body.scrollHeight > body.clientHeight ? body.getBoundingClientRect().right : innerWidth;
      const expectedLeft = Math.min(a.left, rightBound - m.width - 8);
      return { offset: Math.abs(expectedLeft - m.left), gap: Math.min(Math.abs(a.bottom - m.top), Math.abs(a.top - m.bottom)),
        hit: node.contains(document.elementFromPoint(o.left + o.width / 2, o.top + o.height / 2)) };
    });
    assert.ok(geometry.hit && geometry.offset < 1 && geometry.gap <= 6, label + JSON.stringify(geometry));
    return menu;
  };
  const choose = async (dialog, label, name) => (await openMenu(dialog, label)).getByRole('option', { name, exact: true }).click();
  const checkScrolledWorktreeMenu = async dialog => {
    const label = '角色工作树位置';
    const anchor = dialog.getByRole('button', { name: label, exact: true });
    const body = dialog.locator('.dialog-body');
    const originalChoice = await anchor.innerText();
    const placeNearFooter = () => anchor.evaluate(node => {
      const body = node.closest('.dialog-body');
      body.scrollTop += node.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom + 8;
    });
    // An immediate click must survive scroll events queued before the menu opened.
    await placeNearFooter();
    await openMenu(dialog, label);
    await page.keyboard.press('Escape');
    await dialog.getByRole('listbox', { name: label }).waitFor({ state: 'detached' });
    await placeNearFooter();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const menu = await openMenu(dialog, label, async trigger => {
      const box = await trigger.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    });
    const bounds = await menu.evaluate(node => {
      const dialog = node.closest('dialog');
      const trigger = dialog.querySelector('button[aria-label="角色工作树位置"]').getBoundingClientRect();
      const body = dialog.querySelector('.dialog-body').getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      return { menuTop: rect.top, menuBottom: rect.bottom, bodyTop: body.top, bodyBottom: body.bottom,
        anchorTop: trigger.top, anchorBottom: trigger.bottom };
    });
    await snapDialog(dialog, 'worktree-menu-open');
    const scroll = await body.evaluate(node => {
      const box = node.getBoundingClientRect();
      return { top: node.scrollTop, x: box.right - 24, y: box.top + box.height / 2 };
    });
    await page.mouse.move(scroll.x, scroll.y);
    await page.mouse.wheel(0, -220);
    await page.waitForFunction(top => document.querySelector('dialog[open] .dialog-body').scrollTop < top - 100, scroll.top);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await body.evaluate(node => node.scrollTop);
    const closed = await menu.count() === 0;
    const openedAbove = Math.abs(bounds.anchorTop - bounds.menuBottom) <= 6 && bounds.menuTop >= bounds.bodyTop
      && bounds.anchorBottom >= bounds.bodyBottom - 16 && bounds.anchorBottom <= bounds.bodyBottom;
    assert.ok(openedAbove && closed && after < scroll.top - 100, JSON.stringify({ bounds, closed, before: scroll.top, after }));
    await anchor.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await openMenu(dialog, label);
    const beforeDown = await body.evaluate(node => node.scrollTop);
    await page.mouse.move(scroll.x, scroll.y);
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(top => document.querySelector('dialog[open] .dialog-body').scrollTop > top + 70, beforeDown);
    await menu.waitFor({ state: 'detached' });
    const keptScroll = await anchor.evaluate(node => {
      const body = node.closest('.dialog-body'), field = node.getBoundingClientRect(), bounds = body.getBoundingClientRect();
      return { top: body.scrollTop, visible: field.top >= bounds.top && field.bottom <= bounds.bottom };
    });
    assert.ok(keptScroll.visible && keptScroll.top > beforeDown + 70, JSON.stringify(keptScroll));
    assert.equal(await anchor.innerText(), originalChoice);
    assert.equal(await dialog.getByLabel('默认等待时间', { exact: true }).inputValue(), '12.5');
    await snapDialog(dialog, 'worktree-menu-scrolled');
  };
  const checkScrollableOptions = async dialog => {
    const label = '角色思考强度上限';
    const anchor = dialog.getByRole('button', { name: label, exact: true });
    await anchor.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const menu = await openMenu(dialog, label);
    const body = dialog.locator('.dialog-body');
    const parentTop = await body.evaluate(node => node.scrollTop);
    const menuId = await menu.getAttribute('id');
    const waitForListScroll = up => page.waitForFunction(({ menuId, up }) => {
      const node = document.getElementById(menuId);
      return node && (up ? node.scrollTop < 2 : node.scrollTop > 5);
    }, { menuId, up });
    assert.ok(await menu.evaluate(node => node.scrollHeight > node.clientHeight + 15));
    await menu.hover();
    await page.mouse.wheel(0, 350);
    await waitForListScroll(false);
    await page.mouse.wheel(0, 350);
    await page.keyboard.press('End');
    const lastOption = menu.getByRole('option').last();
    assert.ok(await lastOption.evaluate(node => node === document.activeElement));
    await page.keyboard.press('Home');
    await waitForListScroll(true);
    assert.ok(await menu.getByRole('option').first().evaluate(node => node === document.activeElement));
    assert.equal(await body.evaluate(node => node.scrollTop), parentTop);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
  };
  const avatarButton = dialog => dialog.getByRole('button', { name: '更换头像', exact: true });
  const more = dialog => dialog.locator('summary').filter({ hasText: '更多运行设置' });
  const basicModel = '验收模型 · 验收模型', reviewModel = '验收模型 · 审阅推理模型';
  const checkDefaultRows = async (narrow = false) => {
    const scopeButtons = await defaults.getByRole('group', { name: '子智能体配置范围' }).getByRole('button')
      .evaluateAll(buttons => buttons.map(node => {
        const box = node.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }));
    assert.ok(scopeButtons.length === 2 && scopeButtons.every(box => Math.abs(box.height - 32) <= 1)
      && Math.abs(scopeButtons[0].width - scopeButtons[1].width) <= 1, JSON.stringify(scopeButtons));
    const controls = ['默认子智能体运行模式', '子智能体默认模型', '子智能体默认思考强度', '子智能体思考强度上限']
      .map(name => defaults.getByRole('button', { name, exact: true }));
    const [mode, model, thinking, limit, scope] = await Promise.all([
      ...controls, defaults.getByRole('group', { name: '子智能体配置范围' }),
    ].map(control => control.boundingBox()));
    const toggles = await defaults.locator('.subagent-switch-row .switch').evaluateAll(rows => rows.map(node => {
      const box = node.getBoundingClientRect();
      return { x: box.x, width: box.width, height: box.height };
    }));
    const aligned = values => Math.max(...values) - Math.min(...values) <= 1;
    const right = box => box.x + box.width;
    assert.ok([mode, model, thinking, limit, scope].every(box => box && Math.abs(box.height - 40) <= 1));
    assert.ok(toggles.length === 2 && toggles.every(box => Math.abs(box.height - 24) <= 1 && Math.abs(right(box) - right(mode)) <= 1), JSON.stringify({ toggles, mode }));
    assert.ok(aligned([mode, thinking, limit, scope].map(right)), JSON.stringify({ mode, thinking, limit, scope }));
    if (narrow) {
      assert.ok(aligned([scope, model, thinking].map(box => box.x)) && Math.abs(right(model) - right(thinking)) <= 1);
    } else {
      assert.ok(model.x < mode.x && Math.abs(model.y - thinking.y) <= 1 && aligned([mode, thinking, limit, scope].map(box => box.x)));
    }
  };
  const advancedDefaults = defaults.locator('summary').filter({ hasText: '运行限制与预算' });
  const projectScope = defaults.getByRole('button', { name: '指定工作区', exact: true });
  const checkDefaultScopes = async () => {
    await snapDialog(defaults, 'shared-defaults-overview');
    await projectScope.click();
    assert.equal(await projectScope.getAttribute('aria-pressed'), 'true');
    const target = defaults.getByRole('button', { name: '子智能体目标工作区', exact: true });
    const targets = await openMenu(defaults, '子智能体目标工作区');
    await targets.getByRole('option', { name: /备用工作区/ }).click();
    await defaults.getByRole('button', { name: '子智能体默认模型', exact: true }).waitFor();
    assert.match(await target.innerText(), /备用工作区/);
    const background = defaults.getByRole('switch', { name: '允许后台子智能体' });
    const supervisor = defaults.getByRole('switch', { name: '允许联系主智能体' });
    await background.click();
    assert.equal(await background.getAttribute('aria-checked'), 'false');
    assert.ok(await defaults.getByRole('button', { name: '默认子智能体运行模式' }).isDisabled());
    assert.ok(await supervisor.isDisabled());
    await background.click();
    assert.equal(await background.getAttribute('aria-checked'), 'true');
    if (await supervisor.getAttribute('aria-checked') !== 'true') await supervisor.click();
    const modelOptions = await openMenu(defaults, '子智能体默认模型');
    await modelOptions.getByRole('option', { name: /审阅推理模型/ }).click();
    await choose(defaults, '子智能体默认思考强度', '高');
    await advancedDefaults.click();
    await checkNumberLayout(defaults);
    const pathButton = await defaults.getByRole('button', { name: /选择位置 · 当前使用 Studio 数据目录/ }).boundingBox();
    const isolation = await defaults.getByRole('button', { name: '子智能体工作树隔离方式' }).boundingBox();
    const secondColumnEnd = await defaults.getByRole('spinbutton', { name: '工作树保留上限' })
      .evaluate(node => node.closest('.subagent-field').getBoundingClientRect().right);
    assert.ok(pathButton.height >= 40 && Math.abs(pathButton.x - isolation.x) <= 1 &&
      Math.abs(pathButton.x + pathButton.width - secondColumnEnd) <= 1, JSON.stringify({ pathButton, isolation, secondColumnEnd }));
    const budget = defaults.getByRole('spinbutton', { name: 'Token 预算', exact: true });
    const cost = defaults.getByRole('spinbutton', { name: '参考成本预算', exact: true });
    assert.ok(Math.abs((await budget.boundingBox()).height - 40) <= 1);
    await budget.fill('12000');
    await cost.fill('1.25');
    await choose(defaults, '子智能体预算超限策略', '阻止新任务');
    await checkActionButtons(defaults, [...defaultActions, '撤销更改']);
    await advancedDefaults.evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await snapDialog(defaults, 'shared-defaults-limits');
    await snapDialog(defaults.locator('.dialog-footer'), 'actions-defaults-footer');
    await defaults.getByRole('button', { name: '关闭', exact: true }).click();
    const discardDefaults = page.getByRole('alertdialog', { name: '放弃未保存更改？' });
    await checkActionButtons(discardDefaults, confirmActions);
    await snapDialog(discardDefaults, 'actions-defaults-discard');
    await discardDefaults.getByRole('button', { name: '取消', exact: true }).click();
    await discardDefaults.waitFor({ state: 'detached' });
    assert.equal(await cost.inputValue(), '1.25');
    await advancedDefaults.click();
    await defaults.locator('.dialog-body').evaluate(node => { node.scrollTop = 0; });
    const viewport = await page.context().newCDPSession(page);
    await viewport.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 720, deviceScaleFactor: 1, mobile: false });
    await checkWidth(defaults);
    await checkDefaultRows(true);
    await checkActionButtons(defaults, [...defaultActions, '撤销更改']);
    await snapDialog(defaults, 'shared-defaults-narrow');
    await defaults.getByRole('button', { name: '关闭弹框' }).click();
    await checkActionButtons(discardDefaults, confirmActions);
    await discardDefaults.getByRole('button', { name: '取消', exact: true }).click();
    await discardDefaults.waitFor({ state: 'detached' });
    await viewport.send('Emulation.clearDeviceMetricsOverride');
    await viewport.detach();
    await defaults.getByRole('button', { name: '保存配置', exact: true }).click();
    await defaults.waitFor({ state: 'detached' });
    const snapshot = cwd => page.evaluate(cwd => window.piApi.subagentSettings(cwd), cwd);
    const [alternate, original] = await Promise.all([snapshot(alternateWorkspace), snapshot(workspace)]);
    assert.equal(alternate.project.defaultModel, 'desktop-qa/review');
    assert.equal(alternate.project.defaultThinking, 'high');
    assert.equal(alternate.project.budgetTokens, 12000);
    assert.equal(alternate.project.budgetCostUsd, 1.25);
    assert.equal(alternate.project.budgetAction, 'stop');
    assert.equal(alternate.user.budgetTokens, 0);
    assert.equal(original.project.budgetTokens, 0);
    await defaultsButton.click();
    await defaults.getByRole('group', { name: '子智能体配置范围' }).waitFor();
    await choose(defaults, '默认子智能体运行模式', '后台 · 完成后回传');
    await defaults.getByRole('button', { name: '关闭弹框' }).click();
    await discardDefaults.getByRole('button', { name: '放弃更改' }).click();
    await defaults.waitFor({ state: 'detached' });
    assert.equal((await snapshot(workspace)).user.defaultMode, original.user.defaultMode);
    await defaultsButton.click();
    await defaults.getByRole('group', { name: '子智能体配置范围' }).waitFor();
  };
  await settings();
  for (const [theme, filename] of [['浅色', 'cards-light'], ['深色', 'cards-dark']]) {
    await open('通用');
    await page.getByRole('button', { name: theme, exact: true }).click();
    const generalHeader = await headerLayout();
    await open('子智能体');
    await roles.getByRole('button', { name: '编辑代码审阅' }).waitFor();
    assert.equal(await roles.locator('.settings-profile-card').count(), 2);
    assert.equal(await defaults.count(), 0);
    assert.deepEqual(await headerLayout(), generalHeader);
    const bounds = await roles.evaluate(node => {
      const box = selector => node.querySelector(selector).getBoundingClientRect();
      return [box('h1').left - box('.settings-profile-grid').left, box('.settings-profile-grid').right - box('.settings-page-header-icon').right,
        box('.settings-profile-grid').right - box('.settings-profile-actions').right];
    });
    assert.ok(bounds.every(delta => Math.abs(delta) <= 1), 'header and card edges align');
    await page.locator('.settings-toast').first().waitFor({ state: 'hidden' });
    await snap(filename);
    await checkActionButtons(roles, ['新建子智能体', '共用运行默认值']);
    const editRows = await roles.locator('.settings-profile-foot').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    assert.ok(editRows.length === 2 && editRows.every(height => Math.abs(height - 40) <= 1), JSON.stringify(editRows));
    if (theme === '浅色') await snapDialog(roles.locator('.settings-profile-toolbar'), 'actions-role-toolbar');
    await defaultsButton.click();
    await defaults.getByRole('group', { name: '子智能体配置范围' }).waitFor();
    await checkBackdrop(defaults);
    await checkWidth(defaults, 704);
    await checkDefaultRows();
    await checkActionButtons(defaults, defaultActions);
    assert.ok(await defaults.getByRole('button', { name: '保存配置' }).isDisabled());
    assert.equal(await defaults.getByRole('navigation').count(), 0);
    const sections = defaults.getByRole('region');
    assert.deepEqual(await sections.getByRole('heading', { level: 3 }).allTextContents(),
      ['配置范围', '运行方式', '模型与思考', '隔离工作树', '工具权限']);
    if (theme === '浅色') {
      await checkDefaultScopes();
      await defaults.getByRole('region', { name: '工具权限' }).scrollIntoViewIfNeeded();
      const toolNames = await defaults.locator('.subagent-tool-copy strong').evaluateAll(nodes => nodes.map(node => ({
        name: node.textContent,
        height: node.getBoundingClientRect().height,
        width: node.getBoundingClientRect().width,
      })));
      assert.ok(toolNames.length > 0 && toolNames.every(item => item.height <= 26 && item.width >= 12), JSON.stringify(toolNames));
      await snapDialog(defaults, 'shared-defaults-tools');
    }
    if (theme === '深色') await snap('shared-defaults-dark');
    await defaults.getByRole('region', { name: '模型与思考' }).scrollIntoViewIfNeeded();
    await (await openMenu(defaults, '子智能体默认模型')).press('Escape');
    await page.keyboard.press('Escape');
    await defaults.waitFor({ state: 'detached' });
    assert.ok(await defaultsButton.evaluate(node => node === document.activeElement));
    if (theme === '浅色') {
      await roles.getByRole('button', { name: '编辑代码审阅' }).click();
      const dialog = page.getByRole('dialog', { name: '编辑子智能体' });
      await checkBackdrop(dialog);
      await checkWidth(dialog);
      await dialog.getByLabel('角色名称').waitFor();
      await checkActionButtons(dialog, editorActions);
      await snapDialog(dialog.locator('.dialog-footer'), 'actions-editor-footer');
      await dialog.locator('.dialog-body img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
      await snap('review-editor-light');
      await snapDialog(dialog, 'form-controls-default');
      await checkFieldLayout(dialog);
      assert.equal(await dialog.locator('details details').count(), 0);
      for (const name of ['角色模型', '角色默认思考强度']) {
        const field = dialog.getByRole('button', { name, exact: true });
        assert.ok(await field.evaluate(node => {
          const rect = node.getBoundingClientRect(), body = node.closest('.dialog-body').getBoundingClientRect();
          return !node.closest('details') && rect.top >= body.top && rect.bottom <= body.bottom + 1;
        }), name + ' is directly visible on opening');
      }
      const avatar = avatarButton(dialog);
      const gallery = dialog.getByRole('group', { name: '内置头像' });
      await avatar.press('Enter');
      await gallery.getByRole('button', { pressed: true }).focus();
      await page.keyboard.press('Escape');
      await gallery.waitFor({ state: 'hidden' });
      assert.ok(await avatar.evaluate(node => node === document.activeElement));
      await avatar.click();
      const categories = dialog.getByRole('group', { name: '头像分类' });
      assert.ok(Math.abs((await categories.boundingBox()).height - 40) <= 1);
      const categoryButtons = await categories.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
      assert.ok(categoryButtons.length === 3 && categoryButtons.every(height => Math.abs(height - 32) <= 1), JSON.stringify(categoryButtons));
      await categories.getByRole('button', { name: '动物' }).click();
      await gallery.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
      await gallery.getByRole('button', { name: '丁香白兔' }).click();
      await gallery.waitFor({ state: 'hidden' });
      assert.ok(await avatar.evaluate(node => node === document.activeElement));
      await avatar.click();
      await gallery.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
      assert.equal(await gallery.getByRole('button', { name: '丁香白兔' }).getAttribute('aria-pressed'), 'true');
      await snap('avatars-light');
      await avatar.press('Escape');
      await choose(dialog, '角色模型', reviewModel);
      const thinking = await openMenu(dialog, '角色默认思考强度');
      await snap('review-thinking-menu-light');
      await thinking.getByRole('option', { name: '高', exact: true }).click();
      await choose(dialog, '角色模型', basicModel);
      const unsupported = dialog.getByRole('alert').filter({ hasText: /不支持/ });
      await unsupported.waitFor();
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      assert.ok(await dialog.getByRole('button', { name: '角色默认思考强度', exact: true }).evaluate(node => node === document.activeElement));
      const limited = await openMenu(dialog, '角色默认思考强度');
      assert.ok(await limited.getByRole('option', { name: /高.*不支持/ }).first().isDisabled());
      await limited.getByRole('option', { name: '关闭', exact: true }).click();
      await unsupported.waitFor({ state: 'hidden' });
      assert.ok(await dialog.getByRole('button', { name: '保存', exact: true }).isEnabled());
      await choose(dialog, '角色模型', reviewModel);
      await choose(dialog, '角色默认思考强度', '高');
      await dialog.locator('.dialog-body').evaluate(node => { node.scrollTop = 0; });
      await snap('review-edited-light');
      const narrow = await page.context().newCDPSession(page);
      await narrow.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 760, deviceScaleFactor: 1, mobile: false });
      await checkWidth(dialog);
      await snap('review-edited-narrow');
      await snapDialog(dialog, 'form-controls-narrow');
      await checkFieldLayout(dialog, true);
      await checkActionButtons(dialog, editorActions);
      await narrow.send('Emulation.clearDeviceMetricsOverride');
      await narrow.detach();
      await more(dialog).click();
      await dialog.getByLabel('最多创建', { exact: true }).waitFor();
      await more(dialog).evaluate(node => node.scrollIntoView({ block: 'start' }));
      await snap('review-runtime-light');
      const spawns = dialog.getByLabel('最多创建', { exact: true });
      const resetSpawns = dialog.getByRole('button', { name: '最多创建恢复继承' });
      await spawns.fill('7');
      await spawns.press('ArrowUp');
      assert.equal(await spawns.inputValue(), '8');
      await spawns.press('ArrowDown');
      assert.equal(await spawns.inputValue(), '7');
      await checkNumberLayout(dialog);
      await resetSpawns.click();
      assert.equal(await spawns.inputValue(), '');
      assert.match(await spawns.getAttribute('placeholder'), /继承/);
      const waitTime = dialog.getByLabel('默认等待时间', { exact: true });
      await waitTime.fill('12.5');
      await dialog.getByRole('heading', { name: '后台与调度' }).evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.mouse.move(0, 0);
      await snapDialog(dialog, 'form-controls-scheduling');
      await checkScrolledWorktreeMenu(dialog);
      const narrowRuntime = await page.context().newCDPSession(page);
      await narrowRuntime.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 760, deviceScaleFactor: 1, mobile: false });
      await checkWidth(dialog);
      await checkNumberLayout(dialog);
      await dialog.getByRole('heading', { name: '后台与调度' }).evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await snapDialog(dialog, 'form-controls-scheduling-narrow');
      await narrowRuntime.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 440, deviceScaleFactor: 1, mobile: false });
      await checkScrollableOptions(dialog);
      await narrowRuntime.send('Emulation.clearDeviceMetricsOverride');
      await narrowRuntime.detach();
      await dialog.getByRole('button', { name: '保存', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await roles.getByRole('button', { name: '编辑代码审阅', exact: true }).click();
      await avatar.click();
      assert.ok(await gallery.getByRole('button', { name: '丁香白兔', pressed: true }).isVisible());
      await gallery.getByRole('button', { name: '丁香白兔' }).click();
      assert.match(await dialog.getByRole('button', { name: '角色模型', exact: true }).innerText(), /审阅推理模型/);
      assert.match(await dialog.getByRole('button', { name: '角色默认思考强度', exact: true }).innerText(), /高/);
      await choose(dialog, '角色默认思考强度', '低');
      await more(dialog).click();
      assert.equal(await waitTime.inputValue(), '12.5');
      await waitTime.fill('');
      assert.match(await waitTime.getAttribute('placeholder'), /继承/);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      const discardRole = page.getByRole('alertdialog', { name: '放弃未保存的角色更改？' });
      await checkActionButtons(discardRole, confirmActions);
      await snapDialog(discardRole, 'actions-editor-discard');
      await discardRole.getByRole('button', { name: '关闭确认' }).click();
      await discardRole.waitFor({ state: 'detached' });
      assert.equal(await waitTime.inputValue(), '');
      assert.match(await dialog.getByRole('button', { name: '角色默认思考强度', exact: true }).innerText(), /低/);
      await dialog.getByRole('button', { name: '关闭弹框' }).click();
      await discardRole.getByRole('button', { name: '放弃更改' }).click();
      await dialog.waitFor({ state: 'detached' });
      const saved = await page.evaluate(async () => (await window.piApi.subagentProfiles()).find(role => role.name === '代码审阅').runtimeOverrides);
      assert.equal(saved.defaultThinking, 'high');
      assert.equal(saved.waitTimeoutMs, 12500);
      assert.equal(saved.maxSpawns, undefined);
    }
  }

  await open('模型配置');
  await page.getByRole('button', { name: '查看已启用模型' }).click();
  const modelDetail = page.getByRole('dialog', { name: '已启用模型', exact: true });
  await checkBackdrop(modelDetail);
  await modelDetail.getByRole('button', { name: '关闭已启用模型' }).click();
  await modelDetail.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '添加模型来源' }).click();
  const modelForm = page.getByRole('dialog', { name: '添加模型来源', exact: true });
  await checkBackdrop(modelForm);
  await modelForm.getByRole('button', { name: '取消', exact: true }).click();
  await modelForm.waitFor({ state: 'detached' });
  await open('子智能体');
  await roles.getByRole('button', { name: '编辑代码审阅' }).click();
  const otherRole = page.getByRole('dialog', { name: '编辑子智能体', exact: true });
  await choose(otherRole, '角色工具权限', '读写文件');
  await otherRole.getByRole('button', { name: '保存', exact: true }).click();
  await otherRole.waitFor({ state: 'detached' });

  await roles.getByRole('button', { name: '新建子智能体' }).click();
  const create = page.getByRole('dialog', { name: '新建子智能体', exact: true });
  await checkWidth(create);
  const viewport = await page.context().newCDPSession(page);
  await viewport.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 620, deviceScaleFactor: 1, mobile: false });
  await checkWidth(create);
  await create.getByLabel('角色名称').waitFor();
  await avatarButton(create).click();
  const narrowGallery = create.getByRole('group', { name: '内置头像' });
  await narrowGallery.getByRole('button').first().click();
  await narrowGallery.waitFor({ state: 'hidden' });
  await choose(create, '角色模型', reviewModel);
  await choose(create, '角色默认思考强度', '低');
  await checkWidth(create);
  await create.locator('.dialog-body').evaluate(node => { node.scrollTop = 0; });
  await page.locator('.settings-toast').first().waitFor({ state: 'hidden' });
  await snap('role-editor-narrow');
  await viewport.send('Emulation.clearDeviceMetricsOverride');
  await viewport.detach();
  await create.getByLabel('角色名称').fill('文档校对');
  await create.getByLabel('何时使用').fill('核对项目文档的引用与术语。');
  await create.getByLabel('角色指令').fill(childMarker);
  await avatarButton(create).click();
  const gallery = create.getByRole('group', { name: '内置头像' });
  const groups = create.getByRole('group', { name: '头像分类' });
  for (const name of ['女生', '动物', '男生']) {
    await groups.getByRole('button', { name, exact: true }).click();
    assert.equal(await gallery.getByRole('button').count(), 16);
    const portraitSizes = await gallery.getByRole('button').evaluateAll(buttons => buttons.map(button => {
      const { width, height } = button.getBoundingClientRect();
      return { width, height };
    }));
    assert.ok(portraitSizes.every(size => Math.abs(size.width - 40) <= 1 && Math.abs(size.height - 40) <= 1), JSON.stringify(portraitSizes));
    await gallery.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    if (name === '动物') await snap('animal-picker');
  }
  await gallery.getByRole('button', { name: '赤铜小卷' }).click();
  await create.locator('.dialog-body').evaluate(node => { node.scrollTop = 0; });
  await snap('avatar-picker');
  await gallery.waitFor({ state: 'hidden' });
  await choose(create, '角色默认思考强度', '关闭');
  await choose(create, '角色模型', basicModel);
  await choose(create, 'MCP 服务范围', '仅使用所选');
  await create.getByRole('checkbox', { name: 'toolkit-demo', exact: true }).check();
  await choose(create, '技能范围', '仅使用所选');
  await create.getByRole('checkbox', { name: 'review-guide', exact: true }).check();
  await more(create).click();
  await choose(create, '角色 Harness 配置', '跟随当前工作区');
  await snap('role-resources');
  await choose(create, '角色工具权限', '只读文件');
  assert.equal(await create.getByRole('button', { name: 'MCP 服务范围' }).isDisabled(), true);
  await create.getByLabel('最多创建', { exact: true }).fill('3');
  await create.getByLabel('Token 预算', { exact: true }).fill('0');
  await choose(create, '角色达到预算后', '停止新任务');
  await create.getByRole('button', { name: '角色达到预算后' }).scrollIntoViewIfNeeded();
  await create.locator('.dialog-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.locator('.settings-toast').first().waitFor({ state: 'hidden' });
  await snap('role-runtime-overrides');
  await create.locator('.dialog-body').evaluate(node => { node.scrollTop = 0; });
  await snap('role-editor');
  await create.getByRole('button', { name: '保存', exact: true }).click();
  await create.waitFor({ state: 'detached' });
  const getCreated = () => page.evaluate(async () => (await window.piApi.subagentProfiles()).find(row => row.description === '核对项目文档的引用与术语。'));
  const created = await getCreated();
  assert.equal(created.avatarId, 'boy-copper-curls');
  assert.equal(created.model, 'desktop-qa/check');
  assert.deepEqual(created.runtimeOverrides, { allowedTools: 'read-only', defaultThinking: 'off', maxSpawns: 3, budgetTokens: 0, budgetAction: 'stop' });
  assert.deepEqual(created.mcpServers, ['toolkit-demo']);
  assert.equal(created.skills.length, 1);
  assert.match(created.skills[0], /^review-guide#[a-f0-9]{24}$/u);
  await page.evaluate(async cwd => {
    const common = await window.piApi.subagentSettings(cwd);
    await window.piApi.saveSubagentSettings({ cwd, scope: 'project', settings: { ...common.project, maxSpawns: 7 } });
  }, workspace);

  await open('返回对话');
  await editor.fill('@');
  await page.getByRole('option').filter({ hasText: 'README.md' }).waitFor();
  assert.equal(await page.getByRole('option').filter({ hasText: '文档校对' }).count(), 0);
  const categories = page.getByRole('group', { name: '引用类别' });
  await categories.getByRole('button', { name: '智能体', exact: true }).click();
  assert.equal(await editor.innerText(), '#');
  await page.getByRole('option').filter({ hasText: '文档校对' }).waitFor();
  await page.locator('.settings-toast').first().waitFor({ state: 'hidden' });
  await snap('chat-mention');
  await page.getByRole('option').filter({ hasText: '文档校对' }).click();
  await editor.locator('.is-agent').filter({ hasText: '文档校对' }).waitFor();
  await editor.press('End');
  await page.keyboard.insertText('核对 @README');
  await page.getByRole('option').filter({ hasText: 'README.md' }).click();
  await editor.locator('.is-file').waitFor();
  await editor.press('End');
  await page.keyboard.insertText('$Toolkit');
  await page.keyboard.insertText(' Starter');
  const capabilities = page.getByRole('listbox', { name: '引用类别' });
  assert.deepEqual(await capabilities.getByRole('option').allTextContents(), ['技能', 'MCP', '插件']);
  await capabilities.getByRole('option', { name: '技能', exact: true }).click();
  const suggestions = page.getByRole('listbox', { name: '引用建议' });
  async function selectToolkitEcho() {
    await capabilities.getByRole('option', { name: 'MCP', exact: true }).click();
    await suggestions.getByRole('option').filter({ hasText: 'toolkit_echo' }).click();
  }
  const bundled = suggestions.getByRole('option').filter({ hasText: '插件 · Toolkit Starter' });
  await bundled.waitFor();
  await snap('plugin-capabilities');
  await bundled.click();
  await editor.locator('.is-skill').waitFor();
  await editor.press('End');
  await page.keyboard.insertText('$toolkit_echo');
  await selectToolkitEcho();
  await editor.locator('.is-mcp').waitFor();
  await settings(); await open('子智能体');
  await roles.getByRole('button', { name: '编辑文档校对' }).click();
  const edit = page.getByRole('dialog', { name: '编辑子智能体' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1880, 1020));
  const accessMenu = await openMenu(edit, '角色工具权限');
  await snap('role-dropdown-dark');
  await accessMenu.press('Escape');
  assert.equal(await edit.isVisible(), true);
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '角色工具权限');
  await edit.getByRole('button', { name: '角色工具权限' }).press('ArrowDown');
  await edit.getByRole('option', { name: '只读文件', exact: true }).press('ArrowDown');
  await edit.getByRole('option', { name: '读写文件', exact: true }).press('Enter');
  assert.match(await edit.getByRole('button', { name: '角色工具权限' }).innerText(), /读写文件/);
  await choose(edit, '角色工具权限', '只读文件');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1250, 870));
  await more(edit).click();
  assert.equal(await edit.getByLabel('最多创建', { exact: true }).inputValue(), '3');
  await edit.getByRole('button', { name: '最多创建恢复继承' }).click();
  assert.equal(await edit.getByLabel('最多创建', { exact: true }).getAttribute('placeholder'), '继承 · 7');
  await more(edit).click();
  await avatarButton(edit).click();
  assert.equal(await edit.getByRole('group', { name: '头像分类' }).getByRole('button', { name: '男生' }).getAttribute('aria-pressed'), 'true');
  await edit.getByRole('group', { name: '头像分类' }).getByRole('button', { name: '动物' }).click();
  await edit.getByRole('button', { name: '丁香白兔', exact: true }).click();
  await edit.getByLabel('角色名称').fill('资料校对');
  await edit.getByRole('button', { name: '取消' }).click();
  const discard = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: '放弃未保存的角色更改？' }));
  await checkBackdrop(discard);
  await discard.getByRole('button', { name: '取消', exact: true }).click();
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await edit.waitFor({ state: 'detached' });
  assert.equal((await getCreated()).id, created.id);
  assert.equal((await getCreated()).avatarId, 'rabbit-lilac');
  assert.equal((await getCreated()).runtimeOverrides.maxSpawns, undefined);
  assert.equal(await page.evaluate(async () => (await window.piApi.subagentProfiles()).find(row => row.name === '代码审阅').runtimeOverrides.allowedTools), 'read-write');
  await open('返回对话');
  await editor.locator('.is-agent').filter({ hasText: '资料校对' }).waitFor();
  await editor.press('Enter');
  await page.locator('.user-message .ref-chip.is-agent').filter({ hasText: '资料校对' }).waitFor();
  await page.getByText('已收到审阅结果。', { exact: true }).first().waitFor({ timeout: 30000 });
  assert.deepEqual(report, { delegated: true, child: true, fileContext: true, skillBody: true, mcpMethod: true });
  assert.ok(childToolNames.includes('read') && !childToolNames.some(name => ['edit', 'write', 'bash'].includes(name) || name.startsWith('mcp__')));
  await snap('delegated-chat');
  const message = page.locator('.message.user').filter({ hasText: '资料校对' }).first();
  await message.hover();
  await message.getByRole('button', { name: '编辑消息' }).click();
  const historyEditor = page.getByRole('textbox', { name: '编辑消息' });
  await historyEditor.locator('.is-agent').filter({ hasText: '资料校对' }).waitFor();
  await historyEditor.locator('.is-skill').waitFor();
  await historyEditor.locator('.is-mcp').waitFor();
  await historyEditor.press('Escape');
  await historyEditor.waitFor({ state: 'detached' });

  await editor.fill('$toolkit_echo');
  await selectToolkitEcho();
  await editor.press('End');
  await page.keyboard.insertText('执行 MCP_ROUNDTRIP');
  await editor.press('Enter');
  await page.getByText('已验证方法回传。', { exact: true }).first().waitFor({ timeout: 30000 });
  await editor.fill('$toolkit_echo');
  await selectToolkitEcho();
  await page.evaluate(cwd => window.piApi.setMcpMethodEnabled({ server: 'toolkit-demo', method: 'toolkit_echo', enabled: false, cwd }), workspace);
  await editor.press('Enter');
  await page.getByText(/引用的MCP 方法当前不可用/).first().waitFor();
  await editor.locator('.is-mcp').waitFor();
  await editor.fill('#资料校对');
  await page.getByRole('option').filter({ hasText: '资料校对' }).click();
  await settings(); await open('子智能体');
  await roles.getByRole('button', { name: '编辑资料校对' }).click();
  await edit.getByRole('button', { name: '删除角色' }).click();
  const remove = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: '删除这个子智能体？' }));
  await remove.getByRole('button', { name: '删除角色' }).click();
  await edit.waitFor({ state: 'detached' });
  assert.equal(await getCreated(), undefined);
  await open('返回对话');
  await editor.press('Enter');
  await page.getByText(/引用的子智能体已不存在/).first().waitFor();
  await editor.locator('.is-agent').waitFor();
  await message.locator('.is-agent').filter({ hasText: '资料校对' }).waitFor();
  await settings(); await open('子智能体');
  for (const name of ['代码审阅', '资料研究']) {
    await roles.getByRole('button', { name: '编辑' + name }).click();
    await edit.getByRole('button', { name: '删除角色' }).click();
    await remove.getByRole('button', { name: '删除角色' }).click();
    await edit.waitFor({ state: 'detached' });
  }
  const empty = roles.locator('.settings-profile-empty');
  await empty.getByRole('heading', { name: '还没有子智能体' }).waitFor();
  const newRole = roles.getByRole('button', { name: '新建子智能体', exact: true });
  assert.equal(await newRole.count(), 1);
  await page.locator('.settings-toast').first().waitFor({ state: 'hidden' });
  await snap('empty-dark');
  await defaultsButton.click();
  await defaults.getByRole('button', { name: '关闭', exact: true }).click();
  await defaults.waitFor({ state: 'detached' });
  await newRole.click();
  await create.getByLabel('角色名称').fill('首个角色');
  await create.getByLabel('何时使用').fill('检查项目文档。');
  await create.getByRole('button', { name: '保存', exact: true }).click();
  await create.waitFor({ state: 'detached' });
  await roles.getByRole('button', { name: '编辑首个角色' }).waitFor();
  assert.equal(await empty.count(), 0);
  assert.equal(await newRole.count(), 1);
  assert.deepEqual(errors, []);
  console.log('Passed modal blur, anchored and hittable menus, independent role defaults, read-only delegation, 48 portraits, composer references, revocation and history edits.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'desktop-failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await new Promise(resolve => model.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
