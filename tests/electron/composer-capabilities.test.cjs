const assert = require('node:assert/strict');
const test = require('node:test');
const { readableCapabilityReferences, resolveCapabilityReferences } = require('../../electron/main/runtime/composer-capabilities.cjs');

test('explicit resource references bind by type and ID, reload on send and expand each resource once', () => {
  const skill = { type: 'skill', id: 'duplicate#abc', name: 'echo' };
  const mcp = { type: 'mcp', id: 'duplicate#abc', name: 'echo', server: 'manuals' };
  const plugin = { type: 'plugin', id: 'studio.excalidraw', name: 'Excalidraw' };
  const token = option => '$[' + option.type + ':' + encodeURIComponent(option.id) + '|stale]';
  const filename = '@' + JSON.stringify('draft/' + token(skill) + '.md');
  const text = [token(plugin), token(skill), token(mcp), token(skill), filename].join(' ');
  let catalogReads = 0, skillReads = 0;
  const catalog = () => {
    catalogReads++;
    const skillRow = { option: skill, context: () => { skillReads++; return 'trusted skill body'; } };
    return [skillRow, { option: mcp, context: () => 'enabled method' },
      { option: plugin, context: () => 'available plugin', related: [skillRow] }];
  };
  const resolved = resolveCapabilityReferences(text, catalog);
  assert.equal(resolved.context, 'available plugin\n\ntrusted skill body\n\nenabled method');
  assert.equal(readableCapabilityReferences(resolved.display), '$Excalidraw $echo $manuals/echo $echo ' + filename);
  assert.equal(skillReads, 1);
  assert.equal(catalogReads, 1);
  assert.throws(() => resolveCapabilityReferences(token(skill), () => []), /技能当前不可用/);
  assert.throws(() => resolveCapabilityReferences(token(mcp), () => []), /MCP 方法当前不可用/);
  assert.throws(() => resolveCapabilityReferences(token(plugin), () => []), /插件当前不可用/);
  assert.throws(() => resolveCapabilityReferences('$[skill:%ZZ|bad]', catalog), /格式无效/);
  assert.deepEqual(resolveCapabilityReferences(filename + ' $PATH', () => assert.fail()), { display: filename + ' $PATH', context: '' });
});
