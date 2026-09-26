'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  computeFileHash,
  readManifest,
  writeManifest,
  fileStatus,
  emptyManifest,
  MANIFEST_RELATIVE_PATH,
} = require('./manifest');
const { substitute } = require('./placeholders');

const TEMPLATES_DIR = path.resolve(__dirname, '../../templates');

// Files that should always be merge-installed, not overwrite-installed.
const MERGE_TARGETS = new Set(['.mcp.json', '.claude/settings.json']);

// Binary-ish extensions that should skip placeholder substitution.
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.zip', '.ico', '.pdf']);

/**
 * Recursively walk a directory, yielding file paths relative to rootDir.
 */
function walk(rootDir, relDir = '') {
  const out = [];
  const absDir = path.join(rootDir, relDir);
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const entryRel = relDir ? path.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(rootDir, entryRel));
    } else if (entry.isFile()) {
      out.push(entryRel);
    }
  }
  return out;
}

/**
 * Convert a template-file relative path into the destination relative path.
 * Strips a trailing `.tpl` if present.
 */
function destRelFor(templateRel) {
  // Normalize to POSIX separators for manifest keys
  const normalized = templateRel.split(path.sep).join('/');
  return normalized.endsWith('.tpl') ? normalized.slice(0, -4) : normalized;
}

function isBinary(filePath) {
  return BINARY_EXTS.has(path.extname(filePath).toLowerCase());
}

function readJsonIfExists(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

function writeJsonFile(absPath, obj) {
  const content = JSON.stringify(obj, null, 2) + '\n';
  try { if (fs.readFileSync(absPath, 'utf8') === content) return; } catch { /* absent */ }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
}

/**
 * Merge template .mcp.json into existing parent .mcp.json, preserving other
 * MCP servers added by the user.
 */
function mergeMcpJson(existing, template) {
  const result = existing && typeof existing === 'object' ? { ...existing } : {};
  result.mcpServers = { ...(result.mcpServers || {}) };
  for (const [key, value] of Object.entries(template.mcpServers || {})) {
    result.mcpServers[key] = value;
  }
  return result;
}

/**
 * Merge template .claude/settings.json hooks into existing file.
 *
 * Tipatask-owned hook entries carry `_tipatask: true` — we strip those on
 * each install and re-append the template entries. User-added hooks (no
 * marker) survive untouched.
 *
 * Non-hook top-level keys in the existing file are preserved.
 */
function mergeClaudeSettings(existing, template) {
  const result = existing && typeof existing === 'object' ? { ...existing } : {};
  const existingHooks = (result.hooks && typeof result.hooks === 'object') ? result.hooks : {};
  const mergedHooks = { ...existingHooks };

  const templateHooks = (template && template.hooks) || {};
  const phases = new Set([...Object.keys(existingHooks), ...Object.keys(templateHooks)]);

  for (const phase of phases) {
    const existingEntries = Array.isArray(mergedHooks[phase]) ? mergedHooks[phase] : [];
    const userEntries = existingEntries.filter((e) => !(e && e._tipatask === true));
    const templateEntries = Array.isArray(templateHooks[phase]) ? templateHooks[phase] : [];
    const stampedTemplate = templateEntries.map((e) => ({ _tipatask: true, ...e }));
    const combined = [...userEntries, ...stampedTemplate];
    if (combined.length > 0) {
      mergedHooks[phase] = combined;
    } else {
      delete mergedHooks[phase];
    }
  }

  result.hooks = mergedHooks;
  return result;
}

/**
 * Ensure the runtime-written `.tipatask/*` files (never manually authored — safe to
 * regenerate) are gitignored in the parent project. Does not touch the manifest file
 * itself (it stays tracked). C1218 added `.tipatask/kb-reindex-state.json` and, while at
 * it, backfilled `.tipatask/knowledge-versions.json` — present in this repo's own
 * `.gitignore` since C1037 but missing from this required list, so a managed project's
 * `.gitignore` never got it. Returns the list of entries that were actually missing
 * (empty array = nothing changed) instead of a bare boolean, so the caller can report
 * exactly what it added.
 */
function ensureGitignoreEntries(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  // (C1346) .tipatask/recipes/ — api-backend.js's per-project local recipe mirror
  // (recipes-store.js). App-generated, write-only state; same treatment as files/ and images/.
  // (C1382) .claude/settings.local.json now carries a concrete API_TOKEN (written by
  // writeProjectClaudeMcpApproval, project-config.js, so a shell-launched `claude`
  // resolves .mcp.json's ${API_TOKEN} reference) — this repo's own .gitignore has
  // carried the same entry since C1382; a managed project needs it too, or the first
  // credential write is one `git add -A` away from a committed JWT. .codex/ likewise
  // gets a concrete Authorization header baked into config.toml (Codex TOML has no
  // ${VAR} expansion) — this repo's own .gitignore already has `/.codex/`.
  const required = ['.tipatask/*.log', '.tipatask/*.tmp', '.tipatask/knowledge-versions.json', '.tipatask/kb-reindex-state.json', '.tipatask/kb-conflicts-seen.json', '.tipatask/files/', '.tipatask/images/', '.tipatask/recipes/', '.claude/settings.local.json', '.codex/'];
  let content = '';
  try {
    content = fs.readFileSync(gitignorePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const lines = content.split('\n').map((l) => l.trim());
  const missing = required.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return missing;
  const block = (content && !content.endsWith('\n') ? '\n' : '') +
    '\n# tipatask installer runtime\n' + missing.join('\n') + '\n';
  fs.writeFileSync(gitignorePath, (content || '') + block, 'utf8');
  return missing;
}

/**
 * Render a short unified-ish summary of first differing lines between two strings.
 * Returns up to `maxLines` entries or null when content matches.
 */
function diffSummary(oldContent, newContent, maxLines = 5) {
  if (oldContent === newContent) return null;
  const a = oldContent.split('\n');
  const b = newContent.split('\n');
  const out = [];
  const max = Math.min(Math.max(a.length, b.length), 2000);
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      out.push(`  - ${JSON.stringify(a[i] ?? '')}`);
      out.push(`  + ${JSON.stringify(b[i] ?? '')}`);
      if (out.length / 2 >= maxLines) break;
    }
  }
  return out.join('\n');
}

/**
 * Install all templates into a project root.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot                Absolute path to parent project root
 * @param {Record<string,string>} [opts.placeholders]  Placeholder context
 * @param {boolean} [opts.force]                   Overwrite user-modified files
 * @param {boolean} [opts.dryRun]                  Print plan, no writes
 * @param {string} [opts.packageVersion]           Version string recorded in manifest
 */
function installTemplates(opts) {
  const {
    projectRoot,
    placeholders = {},
    force = false,
    dryRun = false,
    packageVersion = '0.0.0',
    templatesDir = TEMPLATES_DIR,
    include = () => true,
  } = opts;

  if (!projectRoot) throw new Error('installTemplates: projectRoot is required');

  const report = {
    written: [],
    skipped: [],
    merged: [],
    warnings: [],
    unchanged: [],
  };

  const manifest = readManifest(projectRoot);
  const nextManifest = emptyManifest(packageVersion);
  nextManifest.files = { ...manifest?.files };

  const templateFiles = walk(templatesDir).filter(rel => include(destRelFor(rel)));
  if (templateFiles.length === 0) {
    report.warnings.push(`No templates found at ${templatesDir}`);
    return report;
  }

  for (const templateRel of templateFiles) {
    const templateAbs = path.join(templatesDir, templateRel);
    const destRel = destRelFor(templateRel);
    const destAbs = path.join(projectRoot, destRel);

    // Read the template content (binary-safe)
    const binary = isBinary(templateRel);
    const rawContent = binary
      ? fs.readFileSync(templateAbs)
      : fs.readFileSync(templateAbs, 'utf8');
    const renderedContent = binary
      ? rawContent
      : substitute(rawContent, placeholders, { source: destRel });

    // Merge path — always merge, regardless of manifest state
    if (MERGE_TARGETS.has(destRel)) {
      const parsedTemplate = JSON.parse(renderedContent);
      let existing;
      try {
        existing = readJsonIfExists(destAbs);
        if (existing === undefined) existing = {};
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('expected a JSON object');
      } catch (err) {
        report.skipped.push({ path: destRel, reason: 'invalid JSON (preserved)' });
        report.warnings.push(`Cannot refresh ${destRel}: ${err.message}`);
        continue;
      }
      let merged;
      if (destRel === '.mcp.json') {
        merged = mergeMcpJson(existing, parsedTemplate);
      } else if (destRel === '.claude/settings.json') {
        merged = mergeClaudeSettings(existing, parsedTemplate);
      } else {
        merged = { ...existing, ...parsedTemplate };
      }
      if (fs.existsSync(destAbs) && fs.readFileSync(destAbs, 'utf8') === JSON.stringify(merged, null, 2) + '\n') {
        report.unchanged.push({ path: destRel });
        continue;
      }
      if (dryRun) {
        report.merged.push({ path: destRel, dryRun: true });
      } else {
        writeJsonFile(destAbs, merged);
        const hash = computeFileHash(destAbs);
        nextManifest.files[destRel] = {
          hash,
          source: `templates/${templateRel.split(path.sep).join('/')}`,
          merge: true,
        };
        report.merged.push({ path: destRel });
      }
      continue;
    }

    // Non-merge: decide by manifest + disk status
    const status = fileStatus(projectRoot, destRel, manifest);

    let shouldWrite = false;
    let reason = '';

    if (status === 'fresh' || status === 'missing' || status === 'unchanged') {
      shouldWrite = true;
      reason = status;
    } else if (status === 'user-modified') {
      if (force) {
        shouldWrite = true;
        reason = 'user-modified (forced)';
        const existingContent = fs.readFileSync(destAbs, 'utf8');
        const summary = binary ? null : diffSummary(existingContent, renderedContent);
        if (summary) report.warnings.push(`Overwriting user edits in ${destRel}:\n${summary}`);
      } else {
        reason = 'user-modified (skipped — pass --force to overwrite)';
        report.skipped.push({ path: destRel, reason });
        nextManifest.files[destRel] = { ...manifest.files[destRel], userModified: true };
        continue;
      }
    } else if (status === 'not-tracked') {
      if (force) {
        shouldWrite = true;
        reason = 'not-tracked (forced)';
      } else {
        reason = 'not-tracked (skipped — pass --force to overwrite)';
        report.skipped.push({ path: destRel, reason });
        continue;
      }
    }

    if (!shouldWrite) continue;

    if (status === 'unchanged' && fs.readFileSync(destAbs).equals(Buffer.from(renderedContent))) {
      report.unchanged.push({ path: destRel });
      continue;
    }

    if (dryRun) {
      report.written.push({ path: destRel, reason: `${reason} (dry-run)` });
      continue;
    }

    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    if (binary) {
      fs.writeFileSync(destAbs, renderedContent);
    } else {
      fs.writeFileSync(destAbs, renderedContent, 'utf8');
    }
    const hash = computeFileHash(destAbs);
    nextManifest.files[destRel] = {
      hash,
      source: `templates/${templateRel.split(path.sep).join('/')}`,
    };
    report.written.push({ path: destRel, reason });
  }

  if (!dryRun) {
    if (manifest?.version !== packageVersion || JSON.stringify(manifest?.files) !== JSON.stringify(nextManifest.files)) {
      writeManifest(projectRoot, nextManifest);
    }
    try {
      const missingGitignoreEntries = ensureGitignoreEntries(projectRoot);
      if (missingGitignoreEntries.length) report.warnings.push(`.gitignore updated with ${missingGitignoreEntries.join(', ')}`);
    } catch (err) {
      report.warnings.push(`Could not update .gitignore: ${err.message}`);
    }
  }

  return report;
}

// Refresh executable harness assets only. Project KB and preset context are
// deliberately outside this selection: opening a project must never re-seed it.
function isHarnessTemplate(rel) {
  return rel === 'AGENTS.md' || rel === 'CLAUDE.md' || rel === '.claude/settings.json'
    || rel.startsWith('.claude/skills/');
}

// Placeholder context for the harness templates. SERVER_ROOT is relative (POSIX form) when
// this checkout sits inside the project being set up — so a git-tracked .claude/settings.json
// or .mcp.json carries no machine-specific absolute path — and absolute otherwise. Absolute
// paths are emitted with forward slashes so they are valid inside JSON templates on Windows.
function buildHarnessPlaceholders(projectRoot, serverRoot) {
  const root = path.resolve(projectRoot);
  const server = path.resolve(serverRoot);
  const relative = path.relative(root, server);
  const toPosix = (p) => p.split(path.sep).join('/');
  const serverPath = !relative.startsWith('..') && !path.isAbsolute(relative)
    ? (toPosix(relative) || '.') : toPosix(server);
  return {
    PROJECT_NAME: path.basename(root),
    PROJECT_ROOT: toPosix(root),
    TASK_APP_PATH: serverPath,
    SERVER_ROOT: serverPath,
    SERVER_NODE_WRAPPER: process.platform === 'win32' ? 'mcp-node.cmd' : 'mcp-node',
  };
}

function refreshHarnessTemplates(projectRoot, serverRoot, { dryRun = false } = {}) {
  return installTemplates({
    projectRoot,
    templatesDir: path.join(serverRoot, 'templates'),
    placeholders: buildHarnessPlaceholders(projectRoot, serverRoot),
    packageVersion: require('../../package.json').version,
    include: isHarnessTemplate,
    dryRun,
  });
}

module.exports = {
  refreshHarnessTemplates,
  buildHarnessPlaceholders,
  installTemplates,
  TEMPLATES_DIR,
  MERGE_TARGETS,
  mergeMcpJson,
  mergeClaudeSettings,
  diffSummary,
  MANIFEST_RELATIVE_PATH,
};
