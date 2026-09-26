'use strict';
// Generate the marked appendix of THIRD-PARTY-NOTICES.md from packaged app
// production dependencies and vendor/pi/node_modules. Exclude the top-level Pi
// tree because build.files omits it; the vendor tree supplies Pi's packaged copy.
// Preserve hand-written text outside markers. --check compares without writing.
// License templates are local for offline generation; unknown SPDX ids fail.

const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.join(__dirname, '..');
const APP_PACKAGE_JSON = path.join(SERVER_ROOT, 'package.json');
const VENDOR_NODE_MODULES = path.join(SERVER_ROOT, 'vendor', 'pi', 'node_modules');
const NOTICES_PATH = path.join(SERVER_ROOT, 'THIRD-PARTY-NOTICES.md');
const TEMPLATES_DIR = path.join(__dirname, 'license-templates');

const BEGIN_MARKER = '<!-- BEGIN GENERATED THIRD-PARTY APPENDIX — do not edit by hand, run `node scripts/gen-third-party-notices.js` -->';
const END_MARKER = '<!-- END GENERATED THIRD-PARTY APPENDIX -->';

// Packages whose manifests live under this path are Pi's own bundled *examples*
// (extension samples shipped inside the @earendil-works/pi-coding-agent tarball),
// not separately-installed dependencies. They carry no `license` field and are not
// part of what electron-builder's extraResources actually ships as third-party code
// — skip them so the count matches vendor/pi/node_modules's real dependency closure.
const SKIP_PATH_SEGMENT = `@earendil-works${path.sep}pi-coding-agent${path.sep}examples${path.sep}`;
// Any package resolved under here is Tree 2's territory (see header) — excluded from
// Tree 1's walk so a package is never attributed twice under two different names.
const EARENDIL_SEGMENT = `node_modules${path.sep}@earendil-works${path.sep}`;

function findPackageJsonFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findPackageJsonFiles(full));
    } else if (entry.isFile() && entry.name === 'package.json') {
      results.push(full);
    }
  }
  return results;
}

function licenseIdOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (l && l.type) || '?').join(' OR ');
  }
  return null;
}

// A real copyright line starts the (trimmed) line with "Copyright" and is followed by
// an actual year or "(c)"/"©" marker — this excludes Apache-2.0's boilerplate prose,
// which mentions "copyright" constantly ("copyright notice that is included...",
// "\"Licensor\" shall mean the copyright owner...") without ever starting a line with it.
const REAL_COPYRIGHT_LINE = /^copyright\b\s*(\(c\)|©)?\s*(\d{4}|\[?\s*yyyy\s*\]?)/i;
// Some upstream LICENSE files (notably unfilled Apache-2.0 NOTICE appendices) ship the
// SPDX template's placeholder verbatim — that's not real attribution, prefer `author`.
const PLACEHOLDER_COPYRIGHT = /yyyy|<year>|<owner>|\[year\]|\[name of copyright owner\]/i;

function authorLine(pkg) {
  if (typeof pkg.author === 'string') return pkg.author;
  if (pkg.author && typeof pkg.author === 'object' && pkg.author.name) {
    return pkg.author.name;
  }
  return null;
}

function copyrightLineFor(pkgDir, pkg) {
  // Prefer an actual "Copyright ..." line from a sibling LICENSE/COPYING file — most
  // accurate. Fall back to the manifest's `author` field, else a placeholder.
  let entries = [];
  try {
    entries = fs.readdirSync(pkgDir);
  } catch {
    entries = [];
  }
  const licenseFile = entries.find((f) => /^(licen[sc]e|copying)/i.test(f));
  if (licenseFile) {
    try {
      const text = fs.readFileSync(path.join(pkgDir, licenseFile), 'utf8');
      const line = text.split('\n').map((l) => l.trim()).find((l) => REAL_COPYRIGHT_LINE.test(l));
      if (line && !PLACEHOLDER_COPYRIGHT.test(line)) return line;
    } catch {
      // fall through to author-based fallback
    }
  }
  return authorLine(pkg) || '—';
}

function toEntry(pkgDir, pkg) {
  const licenseId = licenseIdOf(pkg);
  return {
    name: pkg.name,
    version: pkg.version,
    licenseId: licenseId || 'UNKNOWN',
    copyright: copyrightLineFor(pkgDir, pkg),
  };
}

function dedupeSorted(packages) {
  const seen = new Map();
  for (const p of packages) seen.set(`${p.name}@${p.version}`, p);
  return [...seen.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
}

// Tree 2: vendor/pi/node_modules — full recursive walk, same as before C1531.
function collectPiPackages() {
  const packages = [];
  for (const pjPath of findPackageJsonFiles(VENDOR_NODE_MODULES)) {
    if (pjPath.includes(SKIP_PATH_SEGMENT)) continue;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.name || !pkg.version) continue;
    packages.push(toEntry(path.dirname(pjPath), pkg));
  }
  return dedupeSorted(packages);
}

// Tree 1: TipΔTask's own production closure. BFS from package.json `dependencies`
// (devDependencies excluded — never packed), following each resolved package's own
// `dependencies` + `optionalDependencies` (this is what picks up the 7
// sherpa-onnx-<platform> prebuild packages staged by scripts/stage-sherpa-bundle.js for
// asarUnpack). Resolution follows Node's own node_modules walk-up rule so hoisted and
// nested installs are both found. No `npm ls` call — offline and deterministic.
function resolveInstalled(fromDir, name) {
  let dir = fromDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === SERVER_ROOT) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function collectAppPackages() {
  const rootPkg = JSON.parse(fs.readFileSync(APP_PACKAGE_JSON, 'utf8'));
  const seen = new Map(); // resolved dir -> pkg
  const queue = Object.keys(rootPkg.dependencies || {}).map((name) => [SERVER_ROOT, name]);
  while (queue.length) {
    const [fromDir, name] = queue.shift();
    const dir = resolveInstalled(fromDir, name);
    if (!dir || seen.has(dir) || dir.includes(EARENDIL_SEGMENT)) continue;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    seen.set(dir, pkg);
    const deps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
    for (const depName of Object.keys(deps)) queue.push([dir, depName]);
  }
  const packages = [];
  for (const [dir, pkg] of seen) {
    if (!pkg.name || !pkg.version) continue;
    packages.push(toEntry(dir, pkg));
  }
  return dedupeSorted(packages);
}

function loadTemplate(spdxId) {
  // DOMPurify offers either license. This distribution takes its Apache-2.0
  // option while retaining the package's full SPDX expression in the table.
  const selectedId = spdxId === '(MPL-2.0 OR Apache-2.0)' ? 'Apache-2.0' : spdxId;
  const file = path.join(TEMPLATES_DIR, `${selectedId}.txt`);
  try {
    return fs.readFileSync(file, 'utf8').trimEnd();
  } catch {
    return null;
  }
}

function assertKnownLicenses(allPackages) {
  const licenseIds = [...new Set(allPackages.map((p) => p.licenseId))].sort();
  const unknown = licenseIds.filter((id) => id === 'UNKNOWN' || !loadTemplate(id));
  if (unknown.length) {
    console.error(
      `[gen-third-party-notices] ERROR: no bundled license template for: ${unknown.join(', ')}\n` +
      `  Add scripts/license-templates/<SPDX-id>.txt (verbatim SPDX text) for each, then re-run.`
    );
    process.exit(1);
  }
  return licenseIds;
}

function tableLines(packages) {
  const lines = ['| Package | License | Copyright |', '|---|---|---|'];
  for (const p of packages) {
    const copyright = p.copyright.replace(/\|/g, '\\|');
    lines.push(`| \`${p.name}@${p.version}\` | ${p.licenseId} | ${copyright} |`);
  }
  return lines;
}

function buildAppendix(appPackages, piPackages) {
  if (appPackages.length === 0) {
    console.error(
      `[gen-third-party-notices] ERROR: found 0 packages in TipΔTask's own dependency closure ` +
      `(expected the top-level node_modules to be populated — run \`npm install\` first).`
    );
    process.exit(1);
  }
  if (piPackages.length === 0) {
    console.error(
      `[gen-third-party-notices] ERROR: found 0 packages in ${VENDOR_NODE_MODULES} ` +
      `(run \`node scripts/stage-pi-bundle.js\` first to stage the Pi bundle).`
    );
    process.exit(1);
  }

  const licenseIds = assertKnownLicenses([...appPackages, ...piPackages]);

  const lines = [];
  lines.push(BEGIN_MARKER);
  lines.push('');
  lines.push('## Bundled dependencies');
  lines.push('');
  lines.push(
    `This appendix lists every third-party package redistributed inside the packaged app, ` +
    `in two groups: TipΔTask's own production dependency closure (shipped inside \`app.asar\`) ` +
    `and the bundled Pi Coding Agent's full dependency closure (shipped as ` +
    `\`vendor/pi/node_modules\`, outside the asar — see \`scripts/stage-pi-bundle.js\`). All ` +
    `packages are under permissive licenses (no copyleft). Regenerate with ` +
    '`node scripts/gen-third-party-notices.js`; `--check` verifies it is current.'
  );
  lines.push('');
  lines.push(`### TipΔTask app dependencies (${appPackages.length} packages)`);
  lines.push('');
  lines.push(...tableLines(appPackages));
  lines.push('');
  lines.push(`### Pi Coding Agent bundle (${piPackages.length} packages)`);
  lines.push('');
  lines.push(...tableLines(piPackages));
  lines.push('');
  lines.push('## License texts');
  lines.push('');
  lines.push('Each distinct license used above, verbatim, once — per-package copyright lines are in the tables above. For (MPL-2.0 OR Apache-2.0), this distribution uses the Apache-2.0 option.');
  lines.push('');
  for (const id of licenseIds) {
    lines.push(`### ${id}`);
    lines.push('');
    lines.push('~~~text');
    lines.push(loadTemplate(id));
    lines.push('~~~');
    lines.push('');
  }
  lines.push(END_MARKER);
  return lines.join('\n');
}

function currentFileParts() {
  let content;
  try {
    content = fs.readFileSync(NOTICES_PATH, 'utf8');
  } catch {
    console.error(`[gen-third-party-notices] ERROR: ${NOTICES_PATH} does not exist — create it with the hand-written Pi section + marker pair first.`);
    process.exit(1);
  }
  const beginIdx = content.indexOf(BEGIN_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    console.error(`[gen-third-party-notices] ERROR: ${NOTICES_PATH} is missing the BEGIN/END generated-appendix markers.`);
    process.exit(1);
  }
  return {
    before: content.slice(0, beginIdx),
    after: content.slice(endIdx + END_MARKER.length),
  };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const { before, after } = currentFileParts();
  const appPackages = collectAppPackages();
  const piPackages = collectPiPackages();
  const appendix = buildAppendix(appPackages, piPackages);
  const next = `${before}${appendix}${after}`;

  if (checkOnly) {
    const existing = fs.readFileSync(NOTICES_PATH, 'utf8');
    if (existing === next) {
      console.log(`[gen-third-party-notices] ${NOTICES_PATH} is up to date (${appPackages.length} app + ${piPackages.length} Pi packages).`);
      process.exit(0);
    }
    console.error(`[gen-third-party-notices] ${NOTICES_PATH} is STALE — run without --check to regenerate.`);
    process.exit(1);
  }

  fs.writeFileSync(NOTICES_PATH, next);
  console.log(
    `[gen-third-party-notices] wrote ${NOTICES_PATH} (${appPackages.length} app + ${piPackages.length} Pi packages, ` +
    `${[...new Set([...appPackages, ...piPackages].map((p) => p.licenseId))].length} distinct licenses).`
  );
}

main();
