'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { imageError } = require('./pi-image-provider');

const EXTENSIONS = Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' });
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_ATTACHMENT_BASE64 = 13_700_000;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function decodeImage(block) {
  if (block.type !== 'image' || typeof block.data !== 'string' || !block.data.length
    || block.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || block.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.data)) throw imageError('invalid');
  const bytes = Buffer.from(block.data, 'base64');
  let mime = '';
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mime = 'image/png';
  else if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) mime = 'image/jpeg';
  else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  else if (bytes.length >= 14 && /^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) mime = 'image/gif';
  else {
    const svg = bytes.toString('utf8');
    if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg) && /<\/svg>\s*$/i.test(svg)
      && !/<(?:script|foreignObject)|<!|\bon\w+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|data:|javascript:|\/\/)/i.test(svg)) mime = 'image/svg+xml';
  }
  if (!mime || (block.mimeType && block.mimeType !== mime)) throw imageError('invalid');
  return { bytes, mime, ext: EXTENSIONS[mime], sha256: digest(bytes) };
}

async function safeFolder(root, relative) {
  try {
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, relative);
  if (!inside(realRoot, target)) throw imageError('save');
  let current = realRoot;
  for (const part of path.relative(realRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw imageError('save');
  }
  if (!inside(realRoot, await fs.realpath(target))) throw imageError('save');
  return target;
  } catch { throw imageError('save'); }
}

function imageStore(userDataRoot, projectRoot, taskId, identity = '') {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(taskId)) throw imageError('settings');
  const project = digest(Buffer.from(`${path.resolve(projectRoot)}\0${identity}`));
  const dir = path.join(userDataRoot, 'image-runs', project, taskId);
  const statePath = path.join(dir, 'state.json');
  return {
    dir,
    async read() {
      try { return JSON.parse(await fs.readFile(statePath, 'utf8')); }
      catch (err) { if (err.code === 'ENOENT') return null; throw imageError('save'); }
    },
    async write(state) {
      try {
      await fs.mkdir(dir, { recursive: true });
      const temp = path.join(dir, `${crypto.randomUUID()}.tmp`);
      await fs.writeFile(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, statePath);
      } catch { throw imageError('save'); }
    },
    async lock() {
      await fs.mkdir(dir, { recursive: true });
      const lockPath = path.join(dir, 'lock');
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
      } catch (err) {
        if (err.code !== 'EEXIST') throw imageError('save');
        const pid = Number(await fs.readFile(lockPath, 'utf8'));
        try { if (!Number.isSafeInteger(pid) || pid < 1) throw imageError('busy'); process.kill(pid, 0); }
        catch (check) {
          if (check.code !== 'ESRCH') throw imageError('busy');
          const recovery = path.join(dir, 'lock-recovery');
          try { await fs.mkdir(recovery); } catch { throw imageError('busy'); }
          try {
            // Serialize stale-lock recovery across server processes. Re-read ownership after
            // acquiring this gate so a newly-created live lock is never removed by a late reader.
            const current = Number(await fs.readFile(lockPath, 'utf8'));
            if (current !== pid) throw imageError('busy');
            await fs.unlink(lockPath);
            return await this.lock();
          } finally { await fs.rmdir(recovery).catch(() => {}); }
        }
        throw imageError('busy');
      }
      return () => fs.unlink(lockPath).catch(() => {});
    },
    cachePath(runId, filename) {
      if (!/^[a-f0-9-]{36}$/.test(runId) || path.basename(filename) !== filename) throw imageError('save');
      return path.join(dir, runId, filename);
    },
    async cache(runId, outputs, taskId) {
      if (!Array.isArray(outputs)) throw imageError('invalid');
      const decoded = outputs.map(decodeImage);
      try {
      const cacheDir = path.dirname(this.cachePath(runId, 'image'));
      await fs.mkdir(cacheDir, { recursive: true });
      const files = [];
      for (const [index, item] of decoded.entries()) {
        const filename = `${taskId}-${runId}-${index + 1}${item.ext}`;
        await fs.writeFile(this.cachePath(runId, filename), item.bytes, { flag: 'wx', mode: 0o600 });
        files.push({ filename, mime: item.mime, sha256: item.sha256, size: item.bytes.length });
      }
      return files;
      } catch { throw imageError('save'); }
    },
    async bytes(state, file) {
      try {
      const cache = this.cachePath(state.runId, file.filename);
      const stat = await fs.lstat(cache);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE_BYTES) throw imageError('save');
      const bytes = await fs.readFile(cache);
      if (digest(bytes) !== file.sha256) throw imageError('save');
      return bytes;
      } catch { throw imageError('save'); }
    },
    async save(state, file, root, relativeFolder) {
      const folder = await safeFolder(root, relativeFolder);
      const target = path.join(folder, file.filename);
      const bytes = await this.bytes(state, file);
      try { await fs.writeFile(target, bytes, { flag: 'wx' }); }
      catch (err) {
        if (err.code !== 'EEXIST') throw imageError('save');
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(target)) !== file.sha256) throw imageError('save');
      }
      return target;
    },
  };
}

module.exports = { imageStore, safeFolder, decodeImage, inside, digest, EXTENSIONS, MAX_ATTACHMENT_BASE64 };
