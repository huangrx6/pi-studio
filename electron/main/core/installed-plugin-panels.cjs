'use strict';

// Previously installed packages keep their original file bytes and installation digest.
function currentPanels(panels) {
  if (!Array.isArray(panels) || !panels.some(panel => panel?.slot === 'panel.side')) return panels;
  return panels.map(panel => {
    if (panel?.slot !== 'panel.side') return panel;
    const next = { ...panel, slot: 'tool.view' };
    if (Array.isArray(panel.slots)) {
      next.slots = panel.slots.map(slot => slot === 'panel.side' ? 'tool.view' : slot);
    }
    if (typeof panel.view?.fullscreen === 'boolean') {
      const { fullscreen, ...view } = panel.view;
      next.view = view;
    }
    return next;
  });
}

function installedPluginManifest(manifest) {
  const panels = currentPanels(manifest?.contributes?.panels);
  if (panels === manifest?.contributes?.panels) return manifest;
  return { ...manifest, contributes: { ...manifest.contributes, panels } };
}

function migrateInstalledPluginPanels(db) {
  const extensions = db.prepare("SELECT id, manifest FROM studio_extensions WHERE origin = 'plugin' AND json_valid(manifest)").all();
  const saveManifest = db.prepare('UPDATE studio_extensions SET manifest = ? WHERE id = ?');
  for (const row of extensions) {
    const previous = JSON.parse(row.manifest);
    const manifest = installedPluginManifest(previous);
    if (manifest !== previous) saveManifest.run(JSON.stringify(manifest), row.id);
  }
  const saveProvides = db.prepare('UPDATE studio_plugins SET provides = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, provides FROM studio_plugins WHERE json_valid(provides)').all()) {
    const provides = JSON.parse(row.provides);
    const panels = currentPanels(provides?.extension?.panels);
    if (panels !== provides?.extension?.panels) {
      provides.extension.panels = panels;
      saveProvides.run(JSON.stringify(provides), row.id);
    }
  }
}

module.exports = { installedPluginManifest, migrateInstalledPluginPanels };
