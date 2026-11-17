const fs = require('node:fs');
const { Readable } = require('node:stream');
const { parseByteRange } = require('../background-media.cjs');

async function mediaResponse(request, filePath, mime, cacheControl) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) return new Response('Media not found', { status: 404 });

  let range;
  try {
    range = parseByteRange(request.headers.get('range'), stat.size);
  } catch {
    return new Response(null, {
      status: 416,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${stat.size}`,
      },
    });
  }

  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'Content-Type': mime,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  });
  let status = 200;
  let start = 0;
  let end = Math.max(0, stat.size - 1);
  if (range) {
    status = 206;
    start = range.start;
    end = range.end;
    headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  }
  headers.set('Content-Length', String(stat.size === 0 ? 0 : end - start + 1));

  const body = request.method === 'HEAD' || stat.size === 0
    ? null
    : Readable.toWeb(fs.createReadStream(filePath, { start, end }));
  return new Response(body, { status, headers });
}

module.exports = { mediaResponse };
