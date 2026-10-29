const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  discardBackgroundMedia,
  fileNameFromUrl,
  importBackgroundMedia,
  mediaKindForPath,
  parseByteRange,
  resolveBackgroundMediaPath,
  urlForFileName,
} = require('../electron/background-media.cjs');

test('background media accepts supported static, animated image, and video extensions', () => {
  assert.equal(mediaKindForPath('/tmp/wallpaper.PNG'), 'image');
  assert.equal(mediaKindForPath('/tmp/animated.gif'), 'image');
  assert.equal(mediaKindForPath('/tmp/animated.webp'), 'image');
  assert.equal(mediaKindForPath('/tmp/background.mp4'), 'video');
  assert.equal(mediaKindForPath('/tmp/background.webm'), 'video');
  assert.equal(mediaKindForPath('/tmp/background.mkv'), null);
  assert.equal(mediaKindForPath('/tmp/background.svg'), null);
});

test('background URLs stay inside the app-owned media directory', () => {
  const root = '/tmp/pi-studio-user-data';
  assert.equal(
    resolveBackgroundMediaPath(root, 'pi-media://background/wallpaper.webp'),
    '/tmp/pi-studio-user-data/background-media/wallpaper.webp',
  );
  assert.throws(
    () => resolveBackgroundMediaPath(root, 'pi-media://background/%2E%2E%2Fsecret.mp4'),
    /无效|越界|支持/,
  );
  assert.throws(
    () => resolveBackgroundMediaPath(root, 'file:///tmp/wallpaper.png'),
    /支持/,
  );
  assert.throws(() => fileNameFromUrl('pi-media://background/notes.txt'), /支持/);
});

test('background media byte ranges are clamped and reject unsatisfiable requests', () => {
  assert.equal(parseByteRange(null, 100), null);
  assert.deepEqual(parseByteRange('bytes=0-99', 100), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange('bytes=80-', 100), { start: 80, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=90-999', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-200', 100), { start: 0, end: 99 });
  assert.throws(() => parseByteRange('bytes=100-', 100), /Range/);
  assert.throws(() => parseByteRange('bytes=20-10', 100), /Range/);
  assert.throws(() => parseByteRange('bytes=0-1,4-5', 100), /Range/);
  assert.throws(() => parseByteRange('items=0-1', 100), /Range/);
  assert.throws(() => parseByteRange('bytes=-0', 100), /Range/);
});

test('background import copies the file, preserves metadata, and can be discarded', async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-studio-background-'));
  t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'My Wallpaper.PNG');
  const userData = path.join(temp, 'user-data');
  await fs.promises.writeFile(source, 'image-bytes');

  const media = await importBackgroundMedia(userData, source, 'stable-id');
  assert.equal(media.kind, 'image');
  assert.equal(media.name, 'My Wallpaper.PNG');
  assert.equal(media.mime, 'image/png');
  assert.equal(media.bytes, 11);
  assert.equal(media.url, urlForFileName('stable-id.png'));
  assert.equal(await fs.promises.readFile(resolveBackgroundMediaPath(userData, media.url), 'utf8'), 'image-bytes');

  assert.equal(await discardBackgroundMedia(userData, media.url), true);
  assert.equal(await discardBackgroundMedia(userData, media.url), false);
});
