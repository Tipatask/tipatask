'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { openRouterImageId, normalizeImageDefaults } = require('../pi-image-settings');

const IMAGE_API = 'https://openrouter.ai/api/v1/images';
const MAX_RESPONSE_BYTES = 80 * 1024 * 1024;
let library;

function imageError(code, status) {
  return Object.assign(new Error(code), { code, ...(status ? { status } : {}) });
}

function piImagesPath(resourcesPath = process.resourcesPath, serverRoot = path.resolve(__dirname, '../..')) {
  const roots = [resourcesPath && path.join(resourcesPath, 'pi'), serverRoot.endsWith('app.asar') && path.join(path.dirname(serverRoot), 'pi'), serverRoot, path.join(serverRoot, 'vendor/pi')].filter(Boolean);
  for (const root of roots) {
    for (const dir of [path.join(root, 'node_modules/@earendil-works/pi-coding-agent/node_modules'), path.join(root, 'node_modules')]) {
      const dist = path.join(dir, '@earendil-works/pi-ai/dist');
      if (fs.existsSync(path.join(dist, 'images-models.js'))) return dist;
    }
  }
  throw imageError('runtime');
}

async function loadPiImages() {
  if (!library) library = (async () => {
    const dist = piImagesPath();
    const models = await import(pathToFileURL(path.join(dist, 'images-models.js')).href);
    const providers = await import(pathToFileURL(path.join(dist, 'providers/openrouter-images.js')).href);
    return { ...models, ...providers };
  })().catch(err => { library = null; throw err; });
  return library;
}

async function boundedJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw imageError('invalid');
  const reader = response.body?.getReader();
  if (!reader) throw imageError('invalid');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw imageError('invalid');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err.code ? err : imageError('invalid');
  } finally { reader.releaseLock(); }
}

async function listImageModels({ fetchFn = fetch, signal } = {}) {
  try {
    const response = await fetchFn(`${IMAGE_API}/models`, { signal: signal || AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw imageError('provider', response.status);
    const json = await boundedJson(response, 4 * 1024 * 1024);
    return (json.data || []).filter(m => m.architecture?.output_modalities?.includes('image'))
      .map(m => ({ id: m.id, name: m.name || m.id, supportedParameters: m.supported_parameters || {} }))
      .sort((a, b) => Number(b.id === 'recraft/recraft-v3') - Number(a.id === 'recraft/recraft-v3'));
  } catch {
    // Discovery is a suggestion, never a reason to prevent entering a valid model id.
    try {
      const { openrouterImagesProvider } = await loadPiImages();
      return openrouterImagesProvider().getModels().map(m => ({ id: m.id, name: m.name || m.id }));
    } catch { return [{ id: 'recraft/recraft-v3', name: 'Recraft V3' }]; }
  }
}

async function generatePiImages(entry, prompt, { signal, fetchFn = fetch, loadLibrary = loadPiImages } = {}) {
  if (signal?.aborted) throw imageError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'canceled');
  if (!prompt?.trim()) throw imageError('prompt');
  const defaults = normalizeImageDefaults(entry);
  const id = openRouterImageId(entry.model);
  const { createImagesModels, openrouterImagesProvider } = await loadLibrary();
  const provider = openrouterImagesProvider();
  const model = provider.getModels().find(m => m.id === id)
    || { id, name: id, provider: 'openrouter', api: 'openrouter-images', input: ['text'], output: ['image'] };
  const collection = createImagesModels();
  let failure;
  collection.setProvider({ ...provider, async generateImages(model, context, options) {
    const result = { api: model.api, provider: 'openrouter', model: id, timestamp: Date.now(), output: [], stopReason: 'stop' };
    try {
      // One paid HTTP request. Neither Pi's legacy chat adapter nor its retry helper is used.
      const response = await fetchFn(IMAGE_API, {
        method: 'POST', redirect: 'error', signal: options.signal,
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: id, prompt: context.input[0].text, aspect_ratio: defaults.aspectRatio, n: defaults.count }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw imageError(({ 401: 'auth', 403: 'auth', 402: 'payment', 429: 'rate' })[response.status] || 'provider', response.status);
      }
      const data = await boundedJson(response);
      if (!Array.isArray(data.data) || data.data.length !== defaults.count) throw imageError('invalid');
      result.output = data.data.map(item => ({ type: 'image', data: item.b64_json, mimeType: item.media_type || '' }));
      if (data.usage) result.usage = data.usage;
      return result;
    } catch (err) {
      failure = options.signal?.aborted ? imageError(options.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'canceled') : (['auth', 'payment', 'rate', 'provider', 'invalid'].includes(err.code) ? err : imageError('provider'));
      return { ...result, stopReason: options.signal?.aborted ? 'aborted' : 'error', errorMessage: failure.code };
    }
  } });
  const result = await collection.generateImages(model, { input: [{ type: 'text', text: prompt }] }, { apiKey: entry.apiKey, signal, maxRetries: 0 });
  if (result.stopReason !== 'stop') throw failure || imageError(signal?.aborted ? 'canceled' : 'runtime');
  return result;
}

module.exports = { generatePiImages, listImageModels, loadPiImages, piImagesPath, boundedJson, imageError, IMAGE_API };
