// Theme-only UI review. Fixtures never touch credentials, sessions or network models.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = new URL('../screenshots/themes/',import.meta.url).pathname;
await fs.mkdir(output,{recursive:true});
const browser = await chromium.launch({executablePath:process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page = await browser.newPage({viewport:{width:1440,height:920}});
page.setDefaultTimeout(10000);
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
  const cwd='/workspace/pi-studio';
  const model={modelRef:'opencode-go/deepseek-v4.1-flash',label:'DeepSeek V4.1 Flash',thinkingLevel:'max',thinkingLevels:['default','low','high','max'],effectiveThinkingLevel:'max',defaultThinkingLevel:'high'};
  const models=[{id:model.modelRef,provider:'opencode-go',providerName:'OpenCode Go',model:'deepseek-v4.1-flash',name:model.label,contextWindow:1048576,reasoning:true}];
  const workspaces=[{cwd,name:'pi-studio',sessions:[{id:'theme-review',cwd,title:'全局主题预览',messageCount:3,updatedAt:Date.now()}]},{cwd:'/workspace/another-project',name:'another-project',sessions:[]}];
  window.__createdWorkspaces=[];
  window.__sidebarActions=[];
  const snapshot={model,providers:[{id:'opencode-go',name:'OpenCode Go',mode:'key',authConfigured:true,models:1}],customModels:[],enabledModels:[model.modelRef],mcp:[{name:'filesystem',transport:'stdio',enabled:true,target:'node server.js',description:'读取项目文件'}],skills:[],extensions:[],packages:[],extensionData:[],authPath:'/demo/auth.json',mcpPath:'/demo/mcp.json',modelsPath:'/demo/models.json'};
  const messages=[
    {role:'user',content:[{type:'text',text:'请检查全局主题配色，确认代码、图标和状态的可读性。'}]},
    {role:'assistant',content:[{type:'thinking',thinking:'检查背景与文字对比度，并区分运行、成功与错误状态。'},{type:'toolCall',id:'read-theme',name:'read',arguments:{path:'palette.css'}}]},
    {role:'toolResult',toolCallId:'read-theme',toolName:'read',content:[{type:'text',text:'主题变量已读取，亮色与暗色定义完整。'}]},
    {role:'assistant',content:[{type:'text',text:'## 检查结果\n\n背景采用中性灰阶，绿色用于主要操作与选中状态。\n\n```ts\nconst theme = "dark";\nconst contrast = 7.2;\n// 颜色统一来自全局主题\nconsole.log(theme);\n```\n\n- 完成：文字与图标使用全局变量\n- 完成：错误、成功、加载各有独立语义\n\n[查看项目文档](https://example.test/docs)'}]},
    {role:'assistant',content:[],stopReason:'error',errorMessage:'演示错误状态：连接暂时不可用，请稍后重试。'}
  ];
  const api={
    prompt:async()=>{if(window.__promptFailure)throw new Error(window.__promptFailure);},
    setTheme:async theme=>{window.__nativeTheme=theme;},
    state:async()=>({workspaces:workspaces.filter(item=>!item.hidden),cwd,model}),
    sidebarAction:async ({kind,id,action,name})=>{
      window.__sidebarActions.push({kind,id,action,name});
      const item=kind==='workspace'?workspaces.find(item=>item.cwd===id):workspaces.flatMap(item=>item.sessions).find(item=>item.id===id);
      if(!item)throw new Error('Missing fixture');
      if(action==='rename')item[kind==='workspace'?'name':'title']=name;
      if(action==='remove')item.hidden=true;
      if(action==='pin')item.pinned=!item.pinned;
      if(action==='archive')item.archived=!item.archived;
      if(action==='fork') { const fork={...item,id:'fork-fixture',title:item.title+' · 分叉',pinned:false,archived:false};workspaces.find(w=>w.cwd===item.cwd).sessions.push(fork);return fork; }
      return {ok:true};
    },
    settings:async()=>snapshot,
    models:async()=>({models,current:model.modelRef,enabled:snapshot.enabledModels,selection:model}),
    session:async id=>({...workspaces.flatMap(item=>item.sessions).find(item=>item.id===id),messages}),
    createSession:async selected=>{window.__createdWorkspaces.push(selected);return {id:'new',cwd:selected,title:'新会话',messages:[]};},
    chooseWorkspace:async()=>window.__chosenWorkspace,
    composerResources:async()=>({commands:[]}),extensionState:async()=>({statuses:[],footer:''}),
    files:async()=>({path:'',entries:[{name:'palette.css',path:'palette.css',type:'file',size:5800}]}),
    file:async()=>({path:'palette.css',size:5800,binary:false,text:'/* All colors live in palette.css */\n:root { color-scheme: light; }'}),
  };
  window.piApi=new Proxy(api,{get(target,key){if(key in target)return target[key];if(String(key).startsWith('on'))return()=>()=>{};return async()=>undefined;}});
});
async function capture(name){
  await page.screenshot({path:`${output}${name}.png`,animations:'disabled'});
  const overflow=await page.locator('.main, .settings-content, .settings-dialog, .model-popover').evaluateAll(elements=>elements.filter(e=>e.clientWidth && e.scrollWidth>e.clientWidth+2).map(e=>e.className));
  assert.deepEqual(overflow,[]);
}
async function settings(){await page.locator('.bottom-row').click();await page.getByRole('button',{name:'通用',exact:true}).click();await page.getByRole('heading',{name:'外观',exact:true}).waitFor();}
async function setTheme(name,mode){
  await page.getByRole('button',{name,exact:true}).click();
  await page.waitForFunction(mode=>document.documentElement.dataset.theme===mode,mode);
}
try {
  await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:5180');
  await page.locator('.composer textarea').waitFor();
  const workspacePicker=page.getByRole('button',{name:'新对话工作区',exact:true});
  assert.equal(await workspacePicker.innerText(),'选择工作区');
  await page.getByRole('textbox',{name:'发送给 Pi 的消息'}).fill('保留这份草稿');
  assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled(),true);
  await page.getByRole('textbox',{name:'发送给 Pi 的消息'}).press('Enter');
  assert.deepEqual(await page.evaluate(()=>window.__createdWorkspaces),[]);
  await page.getByRole('alert').filter({hasText:'请先选择一个工作区'}).waitFor();
  await workspacePicker.click();
  await page.getByRole('option',{name:'pi-studio /workspace/pi-studio',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled(),false);
  await page.getByRole('button',{name:'取消选择工作区'}).click();
  await settings();
  await page.locator('.settings-back-button').click();
  assert.equal(await workspacePicker.innerText(),'选择工作区');
  await workspacePicker.click();
  await page.getByRole('option',{name:'another-project /workspace/another-project',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'发送给 Pi 的消息'}).inputValue(),'保留这份草稿');
  await page.evaluate(()=>{window.__promptFailure='Fixture send failure';});
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Fixture send failure'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.__createdWorkspaces),['/workspace/another-project']);
  await page.getByRole('button',{name:'新会话',exact:true}).first().click();
  assert.equal(await workspacePicker.innerText(),'another-project');
  assert.deepEqual(await page.evaluate(()=>window.__createdWorkspaces),['/workspace/another-project']);
  await page.evaluate(()=>{window.__promptFailure=undefined;});
  // Browsing outside the known list keeps the draft and selects the new folder.
  await page.getByRole('textbox',{name:'发送给 Pi 的消息'}).fill('打开文件夹时保留草稿');
  await page.evaluate(()=>{window.__chosenWorkspace='/workspace/new-folder';});
  await workspacePicker.click();
  await page.getByRole('option').filter({hasText:'打开其他文件夹…'}).click();
  await page.waitForFunction(()=>document.querySelector('.workspace-choice .pi-select-value')?.textContent==='new-folder');
  assert.equal(await page.getByRole('textbox',{name:'发送给 Pi 的消息'}).inputValue(),'打开文件夹时保留草稿');
  await page.evaluate(()=>{window.__chosenWorkspace=undefined;});
  await workspacePicker.click();
  await page.getByRole('option').filter({hasText:'打开其他文件夹…'}).click();
  assert.equal(await workspacePicker.innerText(),'new-folder');
  await page.getByRole('textbox',{name:'发送给 Pi 的消息'}).fill('');
  await page.getByRole('button',{name:'取消选择工作区'}).click();
  await settings();
  for(const [mode,label] of [['light','浅色'],['dark','深色']]) {
    await setTheme(label,mode);
    assert.equal(await page.evaluate(()=>window.__nativeTheme),mode);
    await capture(`${mode}-settings`);
    await page.getByRole('button',{name:'模型与账号',exact:true}).click();
    await capture(`${mode}-models`);
    await page.getByRole('button',{name:'添加模型来源',exact:true}).click();
    await page.locator('.settings-dialog').waitFor();
    await capture(`${mode}-dialog`);
    await page.keyboard.press('Escape');
    await page.locator('.settings-back-button').click();
    await capture(`${mode}-new-chat`);
    await workspacePicker.click();
    await capture(`${mode}-workspace-menu`);
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'模型与推理设置',exact:true}).click();
    await capture(`${mode}-menu`);
    await page.keyboard.press('Escape');
    if (!await page.locator('.session-row').count()) await page.locator('.workspace-row').first().click();
    await page.locator('.session-row').first().click();
    await page.locator('.assistant-response').first().waitFor();
    await capture(`${mode}-conversation`);
    await page.locator('.activity-drawer > summary').first().click();
    await page.locator('.activity-thinking > summary').first().click();
    assert.equal(await page.locator('.activity-thinking-preview').first().isVisible(),false);
    await capture(`${mode}-thinking-expanded`);
    await page.locator('.chat-scroll').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    await capture(`${mode}-error`);
    await page.getByRole('button',{name:'新会话',exact:true}).first().click();
    await settings();
    await page.getByRole('button',{name:'通用',exact:true}).click();
  }
  await page.emulateMedia({colorScheme:'dark'});
  await setTheme('跟随系统','dark');
  await page.emulateMedia({colorScheme:'light'});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  await setTheme('深色','dark');
  await page.reload();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await page.locator('.composer textarea').waitFor();
  await page.setViewportSize({width:980,height:640});
  await capture('dark-compact');
  // A previous assistant error must not suppress a new IPC/credential failure.
  if (!await page.locator('.session-row').count()) await page.locator('.workspace-row').first().click();
  await page.locator('.session-row').first().click();
  await page.locator('.assistant-error').waitFor();
  await page.evaluate(()=>{window.__promptFailure='无法读取环境变量 EXAMPLE_API_KEY，请重新保存凭据。';});
  await page.getByRole('textbox',{name:'发送给 Pi 的消息'}).fill('再试一次');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'无法读取环境变量 EXAMPLE_API_KEY'}).waitFor();
  await capture('credential-error-after-history');
  await page.setViewportSize({width:1440,height:920});
  const sessionShell=page.locator('.session-row-shell').filter({has:page.locator('.session-title',{hasText:'全局主题预览'})});
  await sessionShell.hover();
  const hoverIcon=sessionShell.locator('.sidebar-row-actions > button').first();
  const beforeHover=await hoverIcon.evaluate(e=>getComputedStyle(e).color);
  await hoverIcon.hover();
  assert.equal(await hoverIcon.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
  await page.waitForFunction(({label,color})=>getComputedStyle(document.querySelector(`button[aria-label="${label}"]`)).color!==color,{label:'全局主题预览的更多操作',color:beforeHover});
  assert.equal(await sessionShell.locator('.sidebar-row-actions').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
  await capture('sidebar-session-hover');
  await page.getByRole('button',{name:'全局主题预览的更多操作',exact:true}).click();
  assert.equal(await page.getByRole('menuitem').count(),5);
  await capture('sidebar-session-menu');
  await page.getByRole('menuitem',{name:'置顶会话',exact:true}).click();
  await sessionShell.locator('.session-pin-mark').waitFor({state:'attached'});
  await sessionShell.hover();
  await page.getByRole('button',{name:'全局主题预览的更多操作',exact:true}).click();
  await page.getByRole('menuitem',{name:'重命名',exact:true}).click();
  await page.getByRole('textbox',{name:'名称',exact:true}).fill('已重命名的会话');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('heading',{name:'已重命名的会话',exact:true}).waitFor();
  const renamedShell=page.locator('.session-row-shell').filter({hasText:'已重命名的会话'});
  await renamedShell.hover();
  await page.getByRole('button',{name:'归档会话：已重命名的会话',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__sidebarActions.filter(e=>e.action==='archive').length),0);
  await capture('sidebar-archive-confirmation');
  await page.getByRole('dialog',{name:'归档这个会话？'}).getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__sidebarActions.filter(e=>e.action==='archive').length),0);
  await renamedShell.hover();
  await page.getByRole('button',{name:'归档会话：已重命名的会话',exact:true}).click();
  await page.getByRole('dialog',{name:'归档这个会话？'}).getByRole('button',{name:'归档会话',exact:true}).click();
  await page.getByRole('button',{name:'查看归档会话',exact:true}).click();
  await renamedShell.hover();
  await page.getByRole('button',{name:'恢复会话：已重命名的会话',exact:true}).click();
  await page.getByRole('dialog',{name:'恢复这个会话？'}).getByRole('button',{name:'恢复会话',exact:true}).click();
  await page.getByRole('button',{name:'返回未归档会话',exact:true}).click();
  await renamedShell.hover();
  await page.getByRole('button',{name:'已重命名的会话的更多操作',exact:true}).click();
  await page.evaluate(()=>{navigator.clipboard.writeText=async value=>{window.__copiedSessionId=value;};});
  await page.getByRole('menuitem',{name:'复制 SessionId',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__copiedSessionId),'theme-review');
  await renamedShell.hover();
  await page.getByRole('button',{name:'已重命名的会话的更多操作',exact:true}).click();
  await page.getByRole('menuitem',{name:'分叉会话',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__sidebarActions.filter(e=>e.action==='fork').length),0);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>window.__sidebarActions.filter(e=>e.action==='fork').length),0);
  await renamedShell.hover();
  await page.getByRole('button',{name:'已重命名的会话的更多操作',exact:true}).click();
  await page.getByRole('menuitem',{name:'分叉会话',exact:true}).click();
  await page.getByRole('dialog',{name:'分叉这个会话？'}).getByRole('button',{name:'创建分叉',exact:true}).click();
  await page.getByRole('heading',{name:'已重命名的会话 · 分叉',exact:true}).waitFor();
  const workspaceShell=page.locator('.workspace-row-shell').filter({hasText:'pi-studio'});
  await workspaceShell.hover();
  await page.getByRole('button',{name:'pi-studio的更多操作',exact:true}).click();
  assert.equal(await page.getByRole('menuitem').count(),2);
  await capture('sidebar-workspace-menu');
  await page.getByRole('menuitem',{name:'重命名工作区',exact:true}).click();
  await page.getByRole('textbox',{name:'名称',exact:true}).fill('工作区别名');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.locator('.workspace-row-shell').filter({hasText:'工作区别名'}).hover();
  await page.getByRole('button',{name:'在工作区别名中新建对话',exact:true}).click();
  assert.equal(await workspacePicker.innerText(),'工作区别名');
  assert.equal(await page.locator('.workspace-choice-label').count(),0);
  await settings();await setTheme('浅色','light');await page.locator('.settings-back-button').click();
  assert.equal(await page.locator('.workspace-choice').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
  await capture('workspace-white-no-label');
  await page.locator('.workspace-row-shell').filter({hasText:'another-project'}).hover();
  await page.getByRole('button',{name:'another-project的更多操作',exact:true}).click();
  await page.getByRole('menuitem',{name:'删除工作区',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__sidebarActions.filter(e=>e.action==='remove').length),0);
  await page.getByRole('dialog',{name:'删除这个工作区？'}).getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__sidebarActions.filter(e=>e.action==='remove').length),0);
  await page.locator('.workspace-row-shell').filter({hasText:'another-project'}).hover();
  await page.getByRole('button',{name:'another-project的更多操作',exact:true}).click();
  await page.getByRole('menuitem',{name:'删除工作区',exact:true}).click();
  await page.getByRole('dialog',{name:'删除这个工作区？'}).getByRole('button',{name:'从侧边栏移除',exact:true}).click();
  await page.locator('.workspace-row-shell').filter({hasText:'another-project'}).waitFor({state:'detached'});
  assert.deepEqual(errors,[]);
  console.log(`Theme UI checks passed. Screenshots: ${output}`);
} finally {await browser.close();}
