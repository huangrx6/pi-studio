// Version 32 merges the old per-conversation document strips once, inside the schema transaction.
function migrateWorktreeLayouts(studio) {
  const db = studio.db;
  const rows = db.prepare(`SELECT l.owner, l.layout, c.public_id AS id, c.workspace, c.title, c.archived
    FROM session_layouts l LEFT JOIN conversations c ON l.owner = 'conversation:' || c.public_id
    WHERE l.surface = 'center' AND (l.owner GLOB 'conversation:*' OR l.owner GLOB 'draft:*')
    ORDER BY c.updated_at, l.owner`).all();
  const trees = studio.workspaceTreeRecords();
  const groups = new Map();
  const navigation = studio.getSessionLayout('studio', 'navigation');
  for (const row of rows) {
    const draft = row.owner.startsWith('draft:');
    const cwd = draft ? row.owner.slice(6) : row.workspace;
    if (!cwd || (!draft && (!row.id || row.archived))) continue;
    const old = JSON.parse(row.layout);
    if (!Array.isArray(old?.tabs)) continue;
    const tree = trees.get(cwd);
    const owner = 'worktree:' + JSON.stringify([cwd, tree?.detached ? 'detached' : tree ? 'branch' : 'directory', tree?.branch ?? '']);
    let group = groups.get(owner);
    if (!group) groups.set(owner, group = { tabs: new Map(), selected: false });
    const selected = draft ? navigation?.cwd === cwd && !navigation?.sessionId : navigation?.sessionId === row.id;
    const chatId = draft ? 'chat' : row.owner;
    if (!draft) group.tabs.set(chatId, { kind: 'conversation', id: chatId, sessionId: row.id, title: row.title, reading: old.reading });
    let active = chatId;
    for (const tab of old.tabs) {
      if (!tab || typeof tab.id !== 'string') continue;
      let id = tab.id;
      if (tab.kind === 'changes') id = JSON.stringify(['changes', tab.sessionId, tab.turnAt]);
      if (tab.kind === 'diff') id = JSON.stringify(['diff', tab.sessionId, tab.turnAt, tab.path]);
      if (tab.kind === 'file' && tab.source !== 'workspace') id = JSON.stringify(['file', tab.cwd, tab.source, tab.path, tab.sessionId]);
      if (!group.tabs.has(id) || selected) group.tabs.set(id, { ...tab, id, preview: false });
      if (tab.id === old.active) active = id;
    }
    if (selected || !group.selected) {
      group.view = { active, lastConversationId: row.id || undefined, files: old.files, side: old.side, gitPage: old.gitPage,
        inspector: old.inspector, childKey: old.childKey, progressPage: old.progressPage, panelCollapsed: old.panelCollapsed };
      group.selected = selected;
    }
  }
  const write = db.prepare("INSERT INTO session_layouts (owner, surface, layout) VALUES (?, 'center', ?)");
  for (const [owner, group] of groups) write.run(owner, JSON.stringify({ ...group.view, tabs: [...group.tabs.values()] }));
  db.exec("DELETE FROM session_layouts WHERE surface = 'center' AND (owner GLOB 'conversation:*' OR owner GLOB 'draft:?*')");
}

module.exports = { migrateWorktreeLayouts };
