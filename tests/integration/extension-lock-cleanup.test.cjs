const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createExtensionDistributionService } = require('../../electron/services/extension-distribution.cjs');

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-studio-extension-lock-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const service=createExtensionDistributionService({userDataPath:path.join(root,'user-data'),appVersion:'0.0.10'});
  async function prepare(version) {
    const source=path.join(root,`source-${version}`);fs.mkdirSync(source);
    fs.writeFileSync(path.join(source,'pi-studio.extension.json'),JSON.stringify({format:1,id:'lock.fixture',name:'Lock fixture',publisher:'synthetic-qa',license:'MIT',version,permissions:[],contributes:{}}));
    return service.prepare(source);
  }
  return {root,service,prepare};
}
async function failLockCleanup(service, action) {
  const lock=path.join(service.stateDirectory('user'),'.lock.fixture.lock');
  const original=fs.rmSync;let injected=0;
  fs.rmSync=function(target,options) {if(path.resolve(target)===path.resolve(lock)){injected++;throw Object.assign(new Error('lock cleanup unavailable'),{code:'EIO'});}return original.call(this,target,options);};
  try { return await action(); }
  finally {fs.rmSync=original;assert.equal(injected,1);assert.equal(fs.existsSync(lock),true);original(lock,{recursive:true,force:true});}
}

test('installation returns its committed version when lock cleanup fails',async t=>{
 const {service,prepare}=fixture(t),preview=await prepare('1.0.0');
 const result=await failLockCleanup(service,()=>service.installPrepared(preview.token));
 assert.equal(result.version,'1.0.0');assert.equal(service.getInstalled('lock.fixture').version,'1.0.0');
});

test('rollback keeps its committed target when lock cleanup fails',async t=>{
 const {service,prepare}=fixture(t);for(const version of ['1.0.0','1.1.0']){const preview=await prepare(version);await service.installPrepared(preview.token);}
 const result=await failLockCleanup(service,()=>service.rollback('lock.fixture'));
 assert.equal(result.version,'1.0.0');assert.equal(service.getInstalled('lock.fixture').version,'1.0.0');
});

test('completed uninstall is not reported failed by lock cleanup and preserves user data',async t=>{
 const {service,prepare}=fixture(t),preview=await prepare('1.0.0'),installed=await service.installPrepared(preview.token);
 fs.writeFileSync(path.join(installed.dataPath,'keep.txt'),'synthetic data');
 const result=await failLockCleanup(service,()=>service.uninstall('lock.fixture'));
 assert.equal(result.removed,true);assert.equal(service.getInstalled('lock.fixture'),undefined);assert.equal(fs.readFileSync(path.join(installed.dataPath,'keep.txt'),'utf8'),'synthetic data');
});

test('lock cleanup failure cannot replace the original precommit rejection',async t=>{
 const {service,prepare}=fixture(t),preview=await prepare('1.0.0');await service.installPrepared(preview.token);
 await assert.rejects(failLockCleanup(service,()=>service.rollback('lock.fixture')),error=>error.code==='NO_ROLLBACK_VERSION');
 assert.equal(service.getInstalled('lock.fixture').version,'1.0.0');
});
