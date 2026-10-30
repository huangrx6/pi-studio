/**
 * Electron custom-protocol QA.
 *
 * Run with Electron rather than Node:
 *   pnpm exec electron tools/qa/qa-background-protocol.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');
const { BACKGROUND_HOST, BACKGROUND_SCHEME } = require('../../electron/background-media.cjs');
const { registerBackgroundProtocol } = require('../../electron/services/background.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-background-protocol-'));
process.once('exit', () => fs.rmSync(userData, { recursive: true, force: true }));
app.setPath('userData', userData);
protocol.registerSchemesAsPrivileged([{
  scheme: BACKGROUND_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

app.whenReady()
  .then(async () => {
    app.dock?.hide();
    await registerBackgroundProtocol();
    const mediaDir = path.join(userData, 'background-media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    fs.writeFileSync(path.join(mediaDir, 'pixel.png'), png);
    const video = Buffer.from(Array.from({ length: 128 }, (_, index) => index));
    fs.writeFileSync(path.join(mediaDir, 'clip.mp4'), video);

    const window = new BrowserWindow({ show: false });
    await window.loadURL('about:blank');
    const url = `${BACKGROUND_SCHEME}://${BACKGROUND_HOST}/pixel.png`;
    const videoUrl = `${BACKGROUND_SCHEME}://${BACKGROUND_HOST}/clip.mp4`;
    const result = await window.webContents.executeJavaScript(`(async () => {
      const full = await fetch(${JSON.stringify(url)});
      const ranged = await fetch(${JSON.stringify(videoUrl)}, { headers: { Range: 'bytes=1-3' } });
      const invalid = await fetch(${JSON.stringify(videoUrl)}, { headers: { Range: 'bytes=999-' } });
      const head = await fetch(${JSON.stringify(videoUrl)}, { method: 'HEAD' });
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error('image failed'));
      });
      image.src = ${JSON.stringify(url)};
      return {
        full: {
          status: full.status,
          type: full.headers.get('content-type'),
          length: (await full.arrayBuffer()).byteLength,
        },
        ranged: {
          status: ranged.status,
          type: ranged.headers.get('content-type'),
          range: ranged.headers.get('content-range'),
          length: (await ranged.arrayBuffer()).byteLength,
        },
        invalid: {
          status: invalid.status,
          range: invalid.headers.get('content-range'),
        },
        head: {
          status: head.status,
          type: head.headers.get('content-type'),
          length: head.headers.get('content-length'),
        },
        image: await loaded,
      };
    })()`);

    assert.deepEqual(result.full, { status: 200, type: 'image/png', length: png.length });
    assert.deepEqual(result.ranged, {
      status: 206,
      type: 'video/mp4',
      range: `bytes 1-3/${video.length}`,
      length: 3,
    });
    assert.deepEqual(result.invalid, { status: 416, range: `bytes */${video.length}` });
    assert.deepEqual(result.head, { status: 200, type: 'video/mp4', length: String(video.length) });
    assert.deepEqual(result.image, { width: 1, height: 1 });
    console.log('Electron background protocol QA passed');
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
