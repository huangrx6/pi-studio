const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DISPLAY_SUFFIX,
  displayCachePath,
  displayScale,
  optimizeImportedBackgroundImage,
  resolveBackgroundDisplayFile,
  shouldAttemptDisplayFit,
} = require('../../electron/main/services/background-display.cjs');

test('displayScale only shrinks when the long edge exceeds the cap', () => {
  assert.equal(displayScale(1920, 1080, 2560), null);
  assert.deepEqual(displayScale(4000, 3000, 2560), { width: 2560, height: 1920 });
  assert.deepEqual(displayScale(3000, 4000, 2560), { width: 1920, height: 2560 });
  assert.equal(displayScale(0, 10, 2560), null);
});

test('animated and video sources are not display-fitted', () => {
  assert.equal(shouldAttemptDisplayFit('image/png'), true);
  assert.equal(shouldAttemptDisplayFit('image/jpeg'), true);
  assert.equal(shouldAttemptDisplayFit('image/gif'), false);
  assert.equal(shouldAttemptDisplayFit('image/png', 'video'), false);
  assert.equal(shouldAttemptDisplayFit('video/mp4', 'video'), false);
});

test('resolveBackgroundDisplayFile writes a cheaper JPEG sibling and reuses it', async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-studio-bg-display-'));
  t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'wall.png');
  await fs.promises.writeFile(source, Buffer.alloc(2_000_000, 7));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, ...Buffer.alloc(40_000, 1)]);
  let resizeCalls = 0;
  const nativeImage = {
    createFromPath() {
      return {
        isEmpty: () => false,
        getSize: () => ({ width: 5000, height: 3000 }),
        resize(size) {
          resizeCalls += 1;
          assert.deepEqual(size, { width: 2560, height: 1536 });
          return this;
        },
        toJPEG() { return jpeg; },
      };
    },
  };

  const first = await resolveBackgroundDisplayFile(source, 'image/png', { nativeImage });
  assert.equal(first.path, displayCachePath(source));
  assert.equal(first.mime, 'image/jpeg');
  assert.equal(first.bytes, jpeg.length);
  assert.equal(resizeCalls, 1);
  assert.equal(await fs.promises.readFile(first.path).then((buf) => buf.equals(jpeg)), true);

  const second = await resolveBackgroundDisplayFile(source, 'image/png', { nativeImage });
  assert.equal(second.path, first.path);
  assert.equal(resizeCalls, 1, 'cached display copy should not rebuild');
});

test('optimizeImportedBackgroundImage rewrites jpeg sources in place', async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-studio-bg-opt-'));
  t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'shot.jpg');
  await fs.promises.writeFile(source, Buffer.alloc(100, 2));
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, ...Buffer.alloc(20, 3)]);
  const nativeImage = {
    createFromPath() {
      return {
        isEmpty: () => false,
        getSize: () => ({ width: 4000, height: 2000 }),
        resize() { return this; },
        toJPEG() { return jpeg; },
      };
    },
  };
  const result = await optimizeImportedBackgroundImage(source, {
    kind: 'image',
    mime: 'image/jpeg',
    nativeImage,
  });
  assert.equal(result.rewritten, true);
  assert.equal(result.path, source);
  assert.equal(await fs.promises.readFile(source).then((buf) => buf.equals(jpeg)), true);
  assert.equal(fs.existsSync(source + DISPLAY_SUFFIX), false);
});
