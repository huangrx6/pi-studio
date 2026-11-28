// AX paths are positional. Keep only the latest bounded snapshot per conversation and window
// and issue a new numeric ref when the identity at a path changes.
const { randomInt } = require('node:crypto');

const snapshots = new Map();
let nextRef = randomInt(1, 0xffffffff);

function snapshotKey(sessionId, windowId) {
  return JSON.stringify([String(sessionId ?? ''), windowId]);
}

function bindSnapshotNodes(sessionId, windowId, pid, nodes) {
  const key = snapshotKey(sessionId, windowId);
  const previous = snapshots.get(key);
  const paths = new Map();
  const refs = new Map();
  for (const node of nodes) {
    const prior = previous?.pid === pid ? previous.paths.get(node.path) : null;
    const identity = node.axIdentity;
    const ref = prior && prior.identity === identity ? prior.ref : `n${nextRef++}`;
    const target = { pid, path: node.path, identity, ref, secure: node.secure };
    paths.set(node.path, target);
    refs.set(ref, target);
    node.ref = ref;
    delete node.axIdentity;
  }
  snapshots.delete(key);
  snapshots.set(key, { pid, paths, refs });
  if (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value);
}

function snapshotTarget(sessionId, windowId, ref, path) {
  const snapshot = snapshots.get(snapshotKey(sessionId, windowId));
  const target = ref ? snapshot?.refs.get(ref) : snapshot?.paths.get(path);
  if (!target || (path && target.path !== path)) {
    const error = new Error('控件引用已失效，请重新读取目标窗口的 desktop_snapshot。');
    error.code = 'desktop_target_not_found';
    throw error;
  }
  return target;
}

// Shared by the snapshot and the action so that a reordered tree or a reused
// path is checked against the same role, identifier and accessible labels.
const JXA_AX_IDENTITY = `
function axIdentity(el, role, name, subrole, description) {
  var identifier = '';
  try { identifier = String(el.attributes.byName('AXIdentifier').value() || ''); } catch (e) {}
  return JSON.stringify([role, name, subrole, description, identifier]);
}
`;

module.exports = { bindSnapshotNodes, snapshotTarget, JXA_AX_IDENTITY };
