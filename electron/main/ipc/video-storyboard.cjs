const { ipcMain, dialog, nativeImage } = require('electron');
const { getWindow } = require('../core/state.cjs');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { extensions, mediaTypes, storyboardStore } = require('../services/video-storyboard/store.cjs');
const { inspectSource } = require('../services/video-storyboard/media.cjs');
const { applyMediaPreferences } = require('../services/video-storyboard/document.cjs');
const { listMediaModels } = require('../services/media-models.cjs');
const { generateMedia, applyGeneratedMedia } = require('../services/video-storyboard/generation.cjs');
const { createDirectorDrafts } = require('../services/video-storyboard/director-drafts.cjs');
const { createPlanningSession } = require('../services/video-storyboard/planning-session.cjs');
const renders = require('../services/video-storyboard/render-files.cjs');

function registerStoryboardIpc() {
  const watched = new WeakSet();
  const drafts = createDirectorDrafts();
  const planning = createPlanningSession();
  function requireMainWindow(event) {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('仅主窗口可以打开视频分镜');
    }
  }
  function handle(channel, action) {
    ipcMain.handle(channel, (event, workspace, ...args) => {
      requireMainWindow(event);
      return action(storyboardStore(getStudioDatabase(), workspace), ...args);
    });
  }
  handle('pi:storyboard-list', store => store.list());
  handle('pi:storyboard-create', (store, example) => store.create(example === 'web-sources'));
  handle('pi:storyboard-render-begin', (store, id, planId, revision) => {
    const contents = getWindow().webContents;
    if (!watched.has(contents)) {
      watched.add(contents);
      contents.on('render-process-gone', renders.discardAll);
      contents.once('destroyed', renders.discardAll);
      contents.on('did-navigate', renders.discardAll);
    }
    return renders.begin(store, id, planId, revision);
  });
  function renderHandle(channel, action) {
    handle('pi:storyboard-render-' + channel, (store, id, token, ...args) => {
      if (!store.owns(id)) throw new Error('找不到此工作区的作品');
      return action(token, id, ...args);
    });
  }
  renderHandle('read', renders.read);
  renderHandle('write', renders.write);
  renderHandle('finish', renders.finish);
  renderHandle('discard', renders.discard);
  renderHandle('save', (token, id) => renders.save(token, id, defaultPath => dialog.showSaveDialog(getWindow(), {
    title: '导出成片', defaultPath, filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
  })));
  handle('pi:storyboard-read', (store, id) => store.read(id));
  handle('pi:storyboard-generate-draft', drafts.propose);
  handle('pi:storyboard-apply-draft', drafts.apply);
  handle('pi:storyboard-discard-draft', drafts.discard);
  ipcMain.handle('pi:storyboard-media-models', event => {
    requireMainWindow(event);
    return listMediaModels();
  });
  handle('pi:storyboard-media-preferences', (store, id, patch) => {
    const catalog = listMediaModels();
    return store.update(id, doc => applyMediaPreferences(doc, patch, catalog), { affectsFilm: false });
  });
  handle('pi:storyboard-generate-media', (store, id, input) => generateMedia(store, id, input));
  handle('pi:storyboard-apply-media', (store, id, input) => applyGeneratedMedia(store, id, input));
  handle('pi:storyboard-edit-brief', (store, id, patch) => store.editBrief(id, patch));
  handle('pi:storyboard-advance', planning.advance);
  handle('pi:storyboard-produce', (store, id, input) => store.startProduction(id, input));
  handle('pi:storyboard-edit-shot', (store, id, shotId, patch) => store.editShot(id, shotId, patch));
  handle('pi:storyboard-preview', async (store, id, assetId) => {
    const source = store.source(id, assetId);
    try { return await inspectSource(id, source, nativeImage); }
    catch { throw new Error('无法读取素材预览，可以重新定位源文件'); }
  });
  handle('pi:storyboard-relink', async (store, id, assetId) => {
    const { asset } = store.source(id, assetId);
    const result = await dialog.showOpenDialog(getWindow(), { title: `重新定位 ${asset.name}`, properties: ['openFile'],
      filters: [{ name: '同类型的素材', extensions: mediaTypes[asset.kind] }] });
    return result.canceled ? store.read(id) : store.relink(id, assetId, result.filePaths[0]);
  });
  handle('pi:storyboard-pick', async (store, id) => {
    store.read(id);
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
      title: '添加创作素材', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片、视频、音频和文稿', extensions }],
    });
    return store.addFiles(id, canceled ? [] : filePaths);
  });
  handle('pi:storyboard-drop', (store, id, paths) => store.addFiles(id, paths));
  handle('pi:storyboard-remove-file', (store, id, assetId) => store.removeFile(id, assetId));
}

module.exports = { registerStoryboardIpc };
