import { hideToolPanel, openToolPanel } from './fixtures/tool-panel.mjs';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchTestDesktop, configureTestModel } from './fixtures/isolated-desktop.mjs';
import { startChecklistModel } from './fixtures/checklist-model.mjs';

const profile = await mkdtemp(path.join(tmpdir(), 'pi-draft-tools-'));
const a = path.join(profile,'A');
const b = path.join(profile,'B');
await Promise.all([mkdir(a), mkdir(b)]);
const model = await startChecklistModel();
let app;
try {
  const desktop = await launchTestDesktop(a, profile, 1200, 820);
  app = desktop.app;
  const main = desktop.page;
  async function choose(dir) {
    await app.evaluate(({dialog}, directory) => {
      dialog.showOpenDialog = async () => ({canceled:false, filePaths:[directory]});
    },dir);
    await main.getByRole('button',{name:'打开工作区',exact:true}).click();
    await main.locator('.workspace-choice.has-selection').filter({hasText:path.basename(dir)}).waitFor();
  }
  await configureTestModel(main,a,model.baseUrl);
  await choose(a);
  const tools = await openToolPanel(app, main);
  const visible = tools.locator('.tool-group:visible');
  const activeKey = () => tools.evaluate(async ()=>(await window.toolWindowApi.state()).key);
  async function activeOwner(key) {
    const deadline = Date.now() + 10000;
    while (!(await activeKey()).startsWith(key)) {
      if (Date.now() >= deadline) throw new Error('Expected tool owner ' + key + ', got ' + await activeKey());
      await delay(25);
    }
  }
  await visible.getByRole('button',{name:'新终端',exact:true}).click();
  await visible.locator('.terminal-live-state.is-running').waitFor();
  await tools.evaluate(()=>{
    window.qaShellOutput='';
    window.piApi.onTerminalEvent(event=>{if(event.type==='data')window.qaShellOutput+=event.data;});
  });
  const pid = async () => {
    await tools.evaluate(()=>{window.qaShellOutput='';});
    const terminal = visible.locator('.tool-content:visible .terminal-panel');
    await terminal.locator('.terminal-live-state.is-running').waitFor();
    await terminal.locator('.terminal-host').click();
    const input = terminal.locator('.xterm-helper-textarea');
    await tools.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
    await tools.keyboard.type('echo QA_SHELL_$$');
    await input.press('Enter');
    const match = await tools.waitForFunction(()=>/QA_SHELL_(\d+)/.exec(window.qaShellOutput)?.[1]);
    return match.jsonValue();
  };
  const initialPid = await pid();
  await visible.getByRole('button',{name:'新建工具标签页'}).click();
  await tools.getByRole('menuitem',{name:'新浏览器标签页',exact:true}).click();
  const guest = visible.locator('webview');
  await guest.waitFor();
  await tools.waitForFunction(()=>{
    try{return document.querySelector('webview').getWebContentsId()>0;}catch{return false;}
  });
  const initialGuest = await guest.evaluate(view=>view.getWebContentsId());
  const initialGroup = await tools.evaluate(async ()=>{
    const state=await window.toolWindowApi.state();
    return state.groups.find(group=>group.context.key===state.key);
  });
  assert.equal(initialGroup.context.key,'draft:'+a);
  await hideToolPanel(main, tools);
  await choose(b);
  await openToolPanel(app, main);
  await activeOwner('draft:'+b);
  await visible.getByRole('button',{name:'新浏览器标签页',exact:true}).waitFor();
  assert.equal(await visible.locator('.tool-tab').count(),0);
  const failure = (owner,kind)=>tools.evaluate(async ({owner,kind})=>{
    try {
      await window.toolWindowApi.command(owner,{kind:'action',action:kind==='file'?{kind,path:'README.md'}:{kind,text:'QA-MUST-NOT-SEND',submit:true}});
      return '';
    } catch (error) {return error.message;}
  },{owner,kind});
  assert.match(await failure('draft:'+a,'prompt'),/切换|变更/);
  await main.evaluate(()=>window.piApi.setToolWindowContext({key:'studio',title:'Pi Studio'}));
  await activeOwner('studio');
  assert.match(await failure('studio','prompt'),/选择.*对话/);
  assert.match(await failure('studio','file'),/选择.*对话/);
  await main.evaluate(()=>window.piApi.setToolWindowContext({key:'room:qa',title:'群聊'}));
  await activeOwner('room:qa');
  assert.match(await failure('room:qa','prompt'),/群聊/);
  await hideToolPanel(main, tools);
  await choose(a);
  await openToolPanel(app, main);
  await activeOwner('draft:'+a);
  assert.equal(await guest.evaluate(view=>view.getWebContentsId()),initialGuest);
  await hideToolPanel(main, tools);
  const composer = main.getByRole('textbox',{name:'发送给 Pi 的消息'});
  await composer.fill('QA-DONE 首次保存会话');
  await main.getByRole('button',{name:'发送消息',exact:true}).click();
  await model.reply('QA-DONE','finish');
  await activeOwner('conversation:');
  await openToolPanel(app, main);
  await visible.locator('.tool-tab').first().waitFor();
  const owner = await activeKey();
  assert.equal(await visible.locator('.tool-tab').count(),2);
  assert.equal(await guest.evaluate(view=>view.getWebContentsId()),initialGuest);
  await visible.locator('.tool-tab:has(.lucide-square-terminal) button').first().click();
  assert.equal(await pid(),initialPid);
  const adoption = await app.evaluate(({app},{owner,old,guest})=>{
    const require=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
    const db=require('./electron/main/core/studio-db.cjs').getStudioDatabase();
    const registry=require('./electron/main/services/browser/tabs.cjs');
    return {old:db.getSessionLayout(old,'tools'),tabs:db.getSessionLayout(owner,'tools')?.tabs.length,
      guest:registry.withBrowserOwner({key:owner},()=>registry.getBrowserTab(guest)?.webContentsId)};
  },{owner,old:'draft:'+a,guest:initialGroup.tabs.find(tab=>tab.kind==='browser').id});
  assert.deepEqual(adoption,{old:null,tabs:2,guest:initialGuest});
  console.log('Passed isolated draft tool tabs, scoped actions, persisted promotion and preservation of the live shell PID and guest WebContents.');
} finally {
  await model.close();
  await app?.close();
  await rm(profile,{recursive:true,force:true});
}
