const mediaLimit = 32 * 1024 * 1024;
const { systemFetch } = require('../../core/http-fetch.cjs');
const jsonLimit = Math.ceil(mediaLimit / 3) * 4 + 65536;

function endpointFor(baseUrl, kind) {
  const url = URL.parse(baseUrl);
  if (!url || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('媒体模型服务地址须为有效的 HTTP 或 HTTPS 地址');
  }
  url.hash = ''; url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') + (kind === 'speech' ? '/audio/speech' : '/images/generations');
  return url;
}

function imageRequest(model, { prompt, aspect }) {
  const body = { model, prompt, n: 1 };
  const portrait = aspect === '9:16', square = aspect === '1:1';
  if (/^dall-e-[23]$/.test(model)) {
    body.response_format = 'b64_json';
    body.size = model === 'dall-e-2' || square ? '1024x1024' : portrait ? '1024x1792' : '1792x1024';
  } else if (model.startsWith('gpt-image-')) {
    const arbitrary = /^gpt-image-2(?:-|\.|$)/.test(model);
    const shortEdge = arbitrary ? 864 : 1024;
    body.size = square ? '1024x1024' : portrait ? `${shortEdge}x1536` : `1536x${shortEdge}`;
  }
  return body;
}

async function responseBytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('模型返回的素材超过 32 MB');
  if (!response.body) throw new Error('模型返回了空内容');
  const parts = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > limit) throw new Error('模型返回的素材超过 32 MB');
    parts.push(chunk);
  }
  if (!length) throw new Error('模型返回了空内容');
  return Buffer.concat(parts, length);
}

async function fetchMedia(fetcher, url, options) {
  let response;
  try { response = await fetcher(url, { ...options, redirect: 'error' }); }
  catch { throw new Error(options.signal.aborted ? '模型生成超时，请重试' : '无法连接模型服务，请检查服务地址与网络'); }
  if (!response.ok) {
    await response.body?.cancel();
    const hint = { 401: '请检查来源凭据', 403: '请检查访问权限', 404: '请检查服务地址和媒体模型 ID',
      400: '请检查模型 ID、输入内容和音色设置', 429: '请检查额度，稍后再试' }[response.status] || '请检查模型服务后再试';
    throw new Error(`模型服务返回 HTTP ${response.status}，${hint}`);
  }
  return response;
}

function imageExtension(bytes) {
  const pngHeader = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (pngHeader && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND') return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.lastIndexOf(Buffer.from([255, 217])) > 15) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' &&
      bytes.length >= 20 && bytes.readUInt32LE(4) + 8 === bytes.length) return 'webp';
  throw new Error('模型未返回可用的 PNG、JPEG 或 WebP 图像');
}

async function imageBytes(response, endpoint, fetcher, signal) {
  if (response.headers.get('content-type')?.startsWith('image/')) return responseBytes(response, mediaLimit);
  const json = await responseBytes(response, jsonLimit);
  let item;
  try { item = JSON.parse(json.toString('utf8')).data?.[0]; }
  catch { throw new Error('生图接口返回了无效的 JSON'); }
  if (typeof item?.b64_json === 'string' && item.b64_json) {
    if (item.b64_json.length > Math.ceil(mediaLimit / 3) * 4) throw new Error('模型返回的素材超过 32 MB');
    const bytes = Buffer.from(item.b64_json, 'base64');
    if (bytes.length > mediaLimit) throw new Error('模型返回的素材超过 32 MB');
    return bytes;
  }
  const location = typeof item?.url === 'string' && item.url && URL.parse(item.url, endpoint);
  if (!location) throw new Error('生图接口没有返回图像内容');
  if (location.origin !== endpoint.origin || location.username || location.password) throw new Error('图片地址来自另一个来源，请使用可返回 b64_json 图像的接口');
  const file = await fetchMedia(fetcher, location, { signal, headers: { Accept: 'image/*' } });
  return responseBytes(file, mediaLimit);
}

async function inspectAudio(bytes) {
  const { Input, BufferSource, ALL_FORMATS } = require('mediabunny');
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  try {
    const track = await input.getPrimaryAudioTrack();
    const mime = (await input.getMimeType()).split(';')[0];
    const ext = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac' }[mime];
    if (!track || !ext) throw new Error();
    const durationMs = Math.ceil(await track.computeDuration() * 1000);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 3600000) throw new Error();
    return { ext, durationMs };
  } catch { throw new Error('语音接口未返回可播放的旁白（最长一小时）'); }
  finally { input.dispose(); }
}

async function requestGeneration(model, input, fetcher = systemFetch) {
  const endpoint = endpointFor(model.baseUrl, input.kind);
  const speech = input.kind === 'speech';
  const headers = { 'Content-Type': 'application/json', Accept: speech ? 'audio/*' : 'application/json' };
  if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
  const body = speech ? { model: model.modelId, input: input.prompt, voice: input.voice, response_format: 'wav' }
    : imageRequest(model.modelId, input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetchMedia(fetcher, endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    if (speech) {
      const bytes = await responseBytes(response, mediaLimit);
      return { bytes, ...await inspectAudio(bytes) };
    }
    const bytes = await imageBytes(response, endpoint, fetcher, controller.signal);
    return { bytes, ext: imageExtension(bytes) };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('模型生成超时，请重试');
    throw error;
  } finally { clearTimeout(timer); controller.abort(); }
}

module.exports = { requestGeneration };
