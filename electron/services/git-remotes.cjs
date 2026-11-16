'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lines = text => text.trimEnd().split(/\r?\n/).filter(Boolean);
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const remoteIO = { remote: true };

function displayUrl(value) {
  if (path.isAbsolute(value) || /^\.{1,2}[\\/]/.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const login = url.protocol === 'ssh:' && url.username ? url.username + '@' : '';
      return url.protocol + '//' + login + url.host + url.pathname;
    } catch { return '已隐藏的远程地址'; }
  }
  if (/^[\w+.-]+::/.test(value)) return '自定义传输地址';
  return value.split(/[?#]/)[0];
}

function validateAddress(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value !== value.trim()
    || /^-|[\x00-\x1f\x7f]|^[\w+.-]+::/.test(value)) throw new Error('请输入有效的远程地址。');
  if (value.includes('://')) {
    let url;
    try { url = new URL(value); } catch { throw new Error('远程地址格式无效。'); }
    if (!['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol)) throw new Error('请选择 HTTPS、SSH、Git 或本地仓库地址。');
    if (url.password || (url.protocol !== 'ssh:' && url.username) || url.search || url.hash) throw new Error('请填写不含凭据或查询参数的仓库地址，认证由 Git 凭据管理器处理。');
  } else if (!path.isAbsolute(value) && !/^\.{1,2}[\\/]/.test(value) && !/^(?:[\w.-]+@)?[\w.-]+:[^:]/.test(value)) {
    throw new Error('请输入仓库 URL、SSH 地址或本地路径。');
  }
  return value;
}

async function requireRemote(run, root, name) {
  if (typeof name !== 'string' || !name || /^-|[\x00-\x1f\x7f]/.test(name)
    || !lines(await run(root, ['remote'])).includes(name)) throw new Error('请选择已配置的远程仓库。');
}
async function remoteConfig(run, root, name) {
  await requireRemote(run, root, name);
  const [fetchText, pushText, explicit] = await Promise.all([
    run(root, ['remote', 'get-url', '--all', name]), run(root, ['remote', 'get-url', '--push', '--all', name]),
    run(root, ['config', '--get-all', 'remote.' + name + '.pushurl'], { allowed: [1] }),
  ]);
  const fetch = lines(fetchText), push = lines(pushText);
  return { fetch, push, info: { name, fetchUrls: fetch.map(displayUrl), pushUrls: push.map(displayUrl),
    editableFetch: fetch.length === 1 && fetch[0] === displayUrl(fetch[0]) ? fetch[0] : '',
    editablePush: explicit && push.length === 1 && push[0] === displayUrl(push[0]) ? push[0] : '',
    explicitPush: Boolean(explicit), version: digest([name, fetchText, pushText, explicit]) } };
}
async function manageRemote(run, root, input) {
  if (input.kind !== 'remoteAdd') {
    const { info } = await remoteConfig(run, root, input.remote);
    if (info.version !== input.version) throw new Error('远程配置已更改，请关闭弹窗后重新查看。');
  }
  if (input.kind === 'remoteAdd' || input.kind === 'remoteRename') {
    const ref = 'refs/remotes/' + input.name + '/test';
    if (typeof input.name !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9._/-]{0,199}$/.test(input.name)
      || (await run(root, ['check-ref-format', '--normalize', ref], { allowed: [1] })).trim() !== ref) throw new Error('远程名称无效。');
    if (lines(await run(root, ['remote'])).includes(input.name)) throw new Error('该远程名称已存在。');
    return input.kind === 'remoteAdd' ? run(root, ['remote', 'add', input.name, validateAddress(input.url)])
      : run(root, ['remote', 'rename', input.remote, input.name]);
  }
  if (input.kind === 'remoteRemove') return run(root, ['remote', 'remove', input.remote]);
  if (!['fetch', 'push'].includes(input.field)) throw new Error('请选择要修改的远程地址。');
  const key = 'remote.' + input.remote + (input.field === 'push' ? '.pushurl' : '.url');
  if (input.field === 'push' && input.url === '') return run(root, ['config', '--local', '--unset-all', key], { allowed: [5] });
  return run(root, ['config', '--local', '--replace-all', key, validateAddress(input.url)]);
}

async function syncTarget(run, root, position, current, operation, remote, targetIndex, remoteVersion) {
  if (!['pull', 'push'].includes(operation) || !position.branch) throw new Error('请先选择本地分支。');
  if (operation === 'push' && !position.head) throw new Error('请先创建首次提交。');
  if ((await run(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { allowed: [1] })).trim()) throw new Error('请先处理当前合并。');
  const config = await remoteConfig(run, root, remote);
  if (remoteVersion !== undefined && remoteVersion !== config.info.version) throw new Error('远程地址已变化，请关闭弹窗并重新选择远程仓库。');
  const multiple = operation === 'push' && config.push.length > 1;
  if (multiple && (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= config.push.length)) throw new Error('请选择本次推送的目标地址。');
  const endpoint = operation === 'push' ? config.push[multiple ? targetIndex : 0] : config.fetch[0];
  if (!endpoint) throw new Error('请先配置远程地址。');
  const target = current?.upstreamRemote === remote && current.upstreamBranch || position.branch;
  const ref = 'refs/heads/' + target;
  const result = await run(root, ['ls-remote', '--refs', '--', endpoint, ref], remoteIO);
  const remoteHead = lines(result).map(row => row.split('\t')).find(([, name]) => name === ref)?.[0] || '';
  if (remoteHead && !oid.test(remoteHead)) throw new Error('无法识别远程提交，请重新获取。');
  if (!remoteHead && operation === 'pull') throw new Error('远程尚无该分支。首次发布请先推送。');
  const tracksEndpoint = !multiple || endpoint === config.fetch[0];
  const setUpstream = operation === 'push' && !current?.upstreamRemote && tracksEndpoint;
  let mergeMode = 'ff';
  if (operation === 'pull') {
    const configured = (await run(root, ['config', '--get', 'pull.ff'], { allowed: [1] })
      || await run(root, ['config', '--get', 'merge.ff'], { allowed: [1] })).trim().toLowerCase();
    if (configured === 'only') mergeMode = 'ff-only';
    else if (['false', 'no', '0', 'off'].includes(configured)) mergeMode = 'no-ff';
  }
  const version = digest([root, position.branch, position.head, operation, remote, config.info.version, endpoint, ref, remoteHead, setUpstream, mergeMode]);
  return { ...position, operation, remote, target, ref, endpoint, multiple, tracksEndpoint, address: displayUrl(endpoint), remoteHead, setUpstream, mergeMode, version };
}
async function commitCount(run, root, tip, exclude) {
  if (!tip || tip === exclude) return 0;
  return Number((await run(root, ['rev-list', '--count', tip, ...(exclude ? ['^' + exclude] : []), '--'])).trim());
}
async function preview(run, root, position, current, input) {
  const target = await syncTarget(run, root, position, current, input.operation, input.remote, input.targetIndex, input.remoteVersion);
  const { remoteHead, endpoint, ref } = target;
  if (remoteHead && !(await run(root, ['rev-parse', '--verify', '--quiet', remoteHead + '^{commit}'], { allowed: [1] })).trim()) {
    // Download objects for review without touching the index, local branch or tracking refs.
    await run(root, ['fetch', '--no-write-fetch-head', '--refmap=', '--no-tags', '--no-recurse-submodules', '--', endpoint, ref], remoteIO);
    if (!(await run(root, ['rev-parse', '--verify', '--quiet', remoteHead + '^{commit}'], { allowed: [1] })).trim()) throw new Error('远程分支已变化，请重新预览。');
  }
  const [incoming, outgoing, dirty] = await Promise.all([
    commitCount(run, root, remoteHead, position.head), commitCount(run, root, position.head, remoteHead),
    input.operation === 'pull' ? run(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-unormal']) : '',
  ]);
  return { ...position, operation: input.operation, remote: input.remote, target: target.target, address: target.address,
    setUpstream: target.setUpstream, mergeMode: target.mergeMode, version: target.version, remoteHead, incoming, outgoing, dirty: Boolean(dirty) };
}
async function commitPage(run, root, { tip, exclude, offset = 0 }) {
  if (!oid.test(tip) || (exclude && !oid.test(exclude)) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('提交范围无效。');
  const rows = await run(root, ['log', '--no-show-signature', '--no-notes', '--format=%H%x00%s', '--max-count=20', '--skip=' + offset,
    tip, ...(exclude ? ['^' + exclude] : []), '--']);
  return lines(rows).map(row => { const [hash, subject] = row.split('\0'); return { hash, subject }; });
}
async function applySync(run, root, position, current, input, readHead) {
  const { remote, target, ref, remoteHead, endpoint, multiple, tracksEndpoint, setUpstream, mergeMode, version } =
    await syncTarget(run, root, position, current, input.kind, input.remote, input.targetIndex);
  if (version !== input.version) throw new Error('分支、远程地址或提交已变化，请重新预览。');
  if (input.kind === 'pull') {
    await run(root, ['fetch', '--no-tags', '--no-recurse-submodules', '--', remote, ref], remoteIO);
    const fetched = (await run(root, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
    const fresh = await readHead(root);
    if (fetched !== remoteHead || position.head !== fresh.head || position.branch !== fresh.branch) throw new Error('分支或提交已变化，请重新预览。');
    return run(root, ['merge', '--' + mergeMode, '--no-edit', '--no-autostash', remoteHead]);
  }
  if (remoteHead && input.force !== true && await commitCount(run, root, remoteHead, position.head)) throw new Error('远程含有仅在该分支上的提交，请先拉取合并，或确认覆盖这些提交。');
  // Pin both ends. Even an explicitly approved overwrite must fail if another push wins the race.
  await run(root, ['-c', 'remote.' + remote + '.mirror=false', 'push', '--no-follow-tags', '--recurse-submodules=no',
    '--force-with-lease=' + ref + ':' + remoteHead, '--', multiple ? endpoint : remote, position.head + ':' + ref], remoteIO);
  if (multiple && tracksEndpoint) {
    try { await run(root, ['fetch', '--no-tags', '--no-recurse-submodules', '--', remote, ref], remoteIO); }
    catch { throw new Error('提交已推送，刷新本地远程记录失败。请重新获取远程信息。'); }
  }
  if (setUpstream) {
    try { await run(root, ['branch', '--set-upstream-to=refs/remotes/' + remote + '/' + target, '--', position.branch]); }
    catch { throw new Error('提交已推送，设置上游分支失败。请检查此远程的分支跟踪配置。'); }
  }
}
module.exports = { requireRemote, remoteConfig, manageRemote, preview, commitPage, applySync };
