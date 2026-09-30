'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { confirm, prompt } = require('./prompts');
const { substitute } = require('./placeholders');
const { spawnMcpClient } = require('./mcp-client');
const { pushFile } = require('./knowledge-sync');
const { registerSeedTags, keepKnownTags, reserveKeysViaMcp } = require('./seed-setup-tasks');
const { taskKeyFormatError } = require('../server/task-key-format');

// ANSI
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
  '.git', '.idea', '.vscode', '.next', '.tipatask',
  '__pycache__', '.venv', 'venv', 'coverage', 'ai', 'skills', '.github',
]);

const STACK_DETECTORS = [
  { file: 'package.json',      label: 'Node.js' },
  { file: 'Cargo.toml',        label: 'Rust' },
  { file: 'go.mod',            label: 'Go' },
  { file: 'pyproject.toml',    label: 'Python' },
  { file: 'requirements.txt',  label: 'Python' },
  { file: 'setup.py',          label: 'Python' },
  { file: 'Gemfile',           label: 'Ruby' },
  { file: 'pom.xml',           label: 'Java (Maven)' },
  { file: 'build.gradle',      label: 'Java (Gradle)' },
  { file: 'composer.json',     label: 'PHP' },
];

function readJsonIfExists(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

function readFileIfExists(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function listTopLevelDirs(projectRoot) {
  try {
    return fs.readdirSync(projectRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function detectStack(projectRoot) {
  const signals = [];
  const labels = new Set();
  for (const detector of STACK_DETECTORS) {
    if (fs.existsSync(path.join(projectRoot, detector.file))) {
      signals.push(detector.file);
      labels.add(detector.label);
    }
  }

  const extra = [];
  const pkg = readJsonIfExists(path.join(projectRoot, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.next) extra.push('Next.js');
    else if (deps.react) extra.push('React');
    if (deps.express) extra.push('Express');
    else if (deps.fastify) extra.push('Fastify');
    if (deps.prisma || deps['@prisma/client']) extra.push('Prisma');
    if (deps.typescript) extra.push('TypeScript');
  }

  if (fs.existsSync(path.join(projectRoot, 'Dockerfile')) ||
      fs.existsSync(path.join(projectRoot, 'docker-compose.yml'))) {
    extra.push('Docker');
  }
  if (fs.existsSync(path.join(projectRoot, '.github', 'workflows'))) {
    extra.push('GitHub Actions');
  }
  if (fs.existsSync(path.join(projectRoot, 'prisma', 'schema.prisma'))) {
    extra.push('Prisma schema');
  }

  const labelParts = [...labels];
  if (extra.length) labelParts.push(...extra);
  return {
    signals,
    summary: labelParts.length ? labelParts.join(' + ') : '(no stack detected)',
  };
}

function buildCommandsTable(projectRoot) {
  const pkg = readJsonIfExists(path.join(projectRoot, 'package.json'));
  if (!pkg || !pkg.scripts) return '';
  const rows = Object.entries(pkg.scripts).map(([name, cmd]) => `| \`${name}\` | \`${cmd}\` |`);
  if (!rows.length) return '';
  return ['| Script | Command |', '|---|---|', ...rows].join('\n');
}

function buildDirTable(projectRoot, dirs) {
  if (!dirs.length) return '';
  const rows = dirs.map((d) => `| \`${d}/\` | _(describe module)_ |`);
  return ['| Path | Purpose |', '|---|---|', ...rows].join('\n');
}

function buildEnvTable(projectRoot) {
  const examples = ['.env.example', '.env.sample', '.env.template'];
  for (const name of examples) {
    const content = readFileIfExists(path.join(projectRoot, name));
    if (!content) continue;
    const rows = content.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const eq = l.indexOf('=');
        if (eq === -1) return null;
        const key = l.slice(0, eq).trim();
        return `| \`${key}\` | _(document purpose)_ |`;
      })
      .filter(Boolean);
    if (!rows.length) continue;
    return ['| Var | Purpose |', '|---|---|', ...rows].join('\n');
  }
  return '';
}

function buildSetupCommands(projectRoot) {
  const lines = [];
  if (fs.existsSync(path.join(projectRoot, 'package.json'))) {
    lines.push('```bash', 'npm install', '```');
  } else if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) {
    lines.push('```bash', 'cargo build', '```');
  } else if (fs.existsSync(path.join(projectRoot, 'go.mod'))) {
    lines.push('```bash', 'go mod download', '```');
  } else if (fs.existsSync(path.join(projectRoot, 'requirements.txt'))) {
    lines.push('```bash', 'pip install -r requirements.txt', '```');
  }
  return lines.join('\n');
}

function buildDbNotes(projectRoot) {
  const notes = [];
  if (fs.existsSync(path.join(projectRoot, 'prisma', 'schema.prisma'))) {
    notes.push('- Prisma schema at `prisma/schema.prisma`.');
  }
  if (fs.existsSync(path.join(projectRoot, 'migrations'))) {
    notes.push('- Migrations directory: `migrations/`.');
  }
  if (fs.existsSync(path.join(projectRoot, 'db', 'migrate'))) {
    notes.push('- Migrations directory: `db/migrate/`.');
  }
  return notes.join('\n');
}

function proposeTagName(dirName) {
  const clean = dirName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `tt-${clean}`;
}

function buildProposedTags(projectRoot, dirs) {
  const proposals = [];
  const pkg = readJsonIfExists(path.join(projectRoot, 'package.json'));
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};

  for (const dir of dirs) {
    const dirAbs = path.join(projectRoot, dir);
    const marker = [];
    if (fs.existsSync(path.join(dirAbs, 'package.json'))) marker.push('package.json');
    if (fs.existsSync(path.join(dirAbs, 'src'))) marker.push('src/');
    if (fs.existsSync(path.join(dirAbs, 'index.js')) ||
        fs.existsSync(path.join(dirAbs, 'index.ts'))) marker.push('entry file');

    const hint = [
      `Top-level module at \`${dir}/\`.`,
      marker.length ? `Detected: ${marker.join(', ')}.` : '',
      'Expand this stub with module purpose, key files, and entry points.',
    ].filter(Boolean).join(' ');

    proposals.push({
      name: proposeTagName(dir),
      description: `${dir} module`,
      architecture_hint: hint,
    });
  }

  if (deps.prisma || fs.existsSync(path.join(projectRoot, 'prisma', 'schema.prisma'))) {
    proposals.push({
      name: 'tt-db',
      description: 'Database schema and connection',
      architecture_hint: 'Prisma schema at `prisma/schema.prisma`. Migrations under `prisma/migrations/`.',
    });
  }
  if (fs.existsSync(path.join(projectRoot, 'migrations')) ||
      fs.existsSync(path.join(projectRoot, 'db', 'migrate'))) {
    proposals.push({
      name: 'tt-migrations',
      description: 'Database migrations',
      architecture_hint: 'SQL or framework migrations. Do not edit applied migrations — add new ones.',
    });
  }
  return proposals;
}

function renderGeneralMd(projectRoot, ctx) {
  const tplPath = path.resolve(__dirname, '..', '..', 'templates', 'ai', 'architecture', 'GENERAL.md.tpl');
  let tpl;
  try {
    tpl = fs.readFileSync(tplPath, 'utf8');
  } catch {
    return null;
  }
  return substitute(tpl, ctx, { source: 'ai/architecture/GENERAL.md' });
}

function writeGeneralMdIfMissing(projectRoot, content) {
  const destDir = path.join(projectRoot, 'ai', 'architecture');
  const dest = path.join(destDir, 'GENERAL.md');
  if (fs.existsSync(dest)) {
    return { written: false, reason: 'exists' };
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, content, 'utf8');
  return { written: true, path: dest };
}

async function reviewTagProposals(proposals) {
  if (!proposals.length) return [];
  console.log(`\n  ${CYAN}Proposed system tags:${RESET}`);
  for (const p of proposals) {
    console.log(`    - ${p.name}  ${DIM}(${p.description})${RESET}`);
  }
  console.log('');
  const createAll = await confirm('  Create all proposed tags?');
  if (createAll) return proposals;

  const selected = [];
  for (const p of proposals) {
    const keep = await confirm(`  Create ${p.name}?`);
    if (keep) selected.push(p);
  }
  return selected;
}

async function createTags(mcp, projectRoot, tags) {
  const created = [];
  const skipped = [];
  const failed = [];
  for (const tag of tags) {
    if (!tag.description || !tag.description.trim()) {
      failed.push({ tag: tag.name, error: 'description required (1 sentence describing module purpose)' });
      console.log(`  ${YELLOW}Skipping ${tag.name}: description required${RESET}`);
      continue;
    }
    try {
      const res = await mcp.callTool('create_system_tag', {
        tag_name: tag.name,
        description: tag.description,
        architecture_hint: tag.architecture_hint,
      });
      if (res && res.exists) {
        skipped.push({ tag: tag.name, reason: 'exists' });
      } else if (res && res.created) {
        created.push({ tag: tag.name, file: res.file });
      } else {
        created.push({ tag: tag.name });
      }
    } catch (err) {
      failed.push({ tag: tag.name, error: err.message });
    }
  }
  return { created, skipped, failed };
}

function writePendingTags(projectRoot, tags) {
  const dir = path.join(projectRoot, '.tipatask');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'pending-tags.json');
  fs.writeFileSync(file, JSON.stringify({ tags }, null, 2) + '\n', 'utf8');
  return file;
}

function buildDiscoveryTaskDesc(tag) {
  return [
    `1. Scan source files in the module dir (Glob/Grep).`,
    `2. Identify key symbols, endpoints, DB tables, env vars.`,
    `3. Update @ai/architecture/${tag}.md — fill Files table, Behavior, Config, endpoints.`,
    `4. For any submodule lacking a tt-* tag: call list_system_tags, create_system_tag if missing.`,
    `5. Update @ai/architecture/GENERAL.md — add missing module row.`,
  ].join('\n');
}

const SYSTEM_TAGS_BLOCK = [
  '',
  '## System Tags',
  '',
  'See `ai/architecture/tt-*.md` for per-module details. Use MCP tools:',
  '- `list_system_tags` — all registered `tt-*` tags',
  '- `get_tag_architecture <tag>` — full architecture doc',
  '- `create_system_tag` — register a new module tag + create stub',
  '',
  '## Conventions',
  '',
  '- Every code change that touches a module → update that module\'s `tt-*.md` before marking task complete.',
  '- Changes to this file (structure, env vars, commands) happen when cross-cutting concerns change.',
  '- See `CLAUDE.md` / `AGENTS.md` for agent workflow and communication style.',
  '',
].join('\n');

const GENERAL_SECTION_KEYWORDS = [
  'system overview', 'stack', 'structure', 'env vars', 'local setup',
  'db', 'commands', 'implementation', 'schema',
];

function parseArchitectureMd(content) {
  const lines = content.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      if (current) sections.push(current);
      current = { heading: m[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  const general = [];
  const modules = [];
  for (const s of sections) {
    const lower = s.heading.toLowerCase();
    const isGeneral = GENERAL_SECTION_KEYWORDS.some((kw) => lower.includes(kw));
    const entry = { heading: s.heading, content: s.lines.join('\n').trim() };
    if (isGeneral) general.push(entry);
    else modules.push(entry);
  }
  return { general, modules };
}

function buildGeneralFromSections(projectName, sections) {
  const parts = [`# ${projectName} — General Architecture\n`];
  for (const s of sections.general) {
    parts.push(`\n## ${s.heading}\n\n${s.content}`);
  }
  parts.push(SYSTEM_TAGS_BLOCK);
  return parts.join('');
}

function buildTagProposalsFromSections(sections) {
  return sections.modules.map(({ heading, content }) => {
    const name = 'tt-' + heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const sentenceMatch = content.match(/[^.!?\n]+[.!?]/);
    const firstSentence = sentenceMatch ? sentenceMatch[0].trim() : content.slice(0, 80);
    const description = firstSentence.length > 80 ? firstSentence.slice(0, 77) + '...' : firstSentence;
    return {
      name,
      description,
      architecture_hint: content.slice(0, 300),
      content,
    };
  });
}

function writeTagMdIfMissing(projectRoot, tagName, content) {
  const dir = path.join(projectRoot, 'ai', 'architecture');
  const filePath = path.join(dir, `${tagName}.md`);
  if (fs.existsSync(filePath)) return { written: false, path: filePath };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `# ${tagName}\n\n${content}\n`, 'utf8');
  return { written: true, path: filePath };
}

// TPT394: discovery tasks never mint their own keys. Keys come from reserve_task_keys
// (prefix+number), each reserved row is finalized in place via update_task (create_task
// would 409 against the reservation row), and a model-supplied id/task_key is always
// overwritten. taskKeyFormatError() gates every write so a slug key fails loudly.
async function seedDiscoveryTasks(mcp, tagNames, { apiBaseUrl, token, projectId } = {}) {
  const defs = tagNames.map((tag) => ({
    title: `Explore ${tag} and enrich ai/architecture/${tag}.md`,
    description: buildDiscoveryTaskDesc(tag),
    category: 'CODING',
    status: 'pending',
    priority: 1,
    tags: [tag, 'feature', 'db-schema'],
  }));
  if (!defs.length) return { seeded: 0, failed: 0, keys: [] };

  // The finalize PATCH 400s wholesale on one unregistered tag (TPT200).
  let known = null;
  if (apiBaseUrl && token && projectId != null) {
    ({ known } = await registerSeedTags({ apiBaseUrl, token, projectId, tagNames: defs.flatMap((d) => d.tags) }));
  }

  let keys;
  try {
    keys = await reserveKeysViaMcp(mcp, defs.length);
  } catch (err) {
    console.log(`  ${RED}Could not reserve task keys for discovery tasks: ${err.message}${RESET}`);
    return { seeded: 0, failed: defs.length, keys: [] };
  }

  let seeded = 0;
  let failed = 0;
  const stranded = [];
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const body = { ...def, tags: keepKnownTags(def.tags, known), task_key: keys[i] };
    delete body.id;
    try {
      const keyErr = taskKeyFormatError(body.task_key);
      if (keyErr) throw new Error(keyErr);
      await mcp.callTool('update_task', body);
      seeded++;
    } catch (err) {
      console.log(`  ${RED}Failed to seed "${def.title}" (${keys[i]}): ${err.message}${RESET}`);
      stranded.push(keys[i]);
      failed++;
    }
  }
  if (stranded.length) {
    console.log(`  ${RED}${stranded.length} discovery task(s) left as blank placeholders: ${stranded.join(', ')}${RESET}`);
  }
  return { seeded, failed, keys };
}

async function runDiscovery({ projectRoot, apiBaseUrl, token, projectId }) {
  if (!projectRoot) throw new Error('runDiscovery: projectRoot required');

  console.log(`\n  ${CYAN}Scanning ${projectRoot}...${RESET}`);

  const archMdPath = path.join(projectRoot, 'ai', 'ARCHITECTURE.md');
  let parsedArch = null;
  if (fs.existsSync(archMdPath)) {
    const raw = fs.readFileSync(archMdPath, 'utf8');
    parsedArch = parseArchitectureMd(raw);
    console.log(`  ${CYAN}Found ai/ARCHITECTURE.md — using as architecture source${RESET}`);
  }

  const dirs = listTopLevelDirs(projectRoot);
  const stack = detectStack(projectRoot);
  const commandsTable = buildCommandsTable(projectRoot);
  const dirTable = buildDirTable(projectRoot, dirs);
  const envTable = buildEnvTable(projectRoot);
  const setupCommands = buildSetupCommands(projectRoot);
  const dbNotes = buildDbNotes(projectRoot);
  let proposedTags = buildProposedTags(projectRoot, dirs);
  if (parsedArch) {
    const archProposals = buildTagProposalsFromSections(parsedArch);
    const archNames = new Set(archProposals.map((p) => p.name));
    proposedTags = [...archProposals, ...proposedTags.filter((p) => !archNames.has(p.name))];
  }

  console.log(`  ${DIM}Stack:${RESET} ${stack.summary}`);
  console.log(`  ${DIM}Top-level dirs:${RESET} ${dirs.length ? dirs.join(', ') : '(none)'}`);

  if (stack.signals.length === 0 && dirs.length === 0) {
    console.log(`  ${YELLOW}Nothing to discover. Skipping.${RESET}`);
    return { skipped: true };
  }

  const selected = await reviewTagProposals(proposedTags);

  // Render GENERAL.md first (independent of MCP)
  const pkg = readJsonIfExists(path.join(projectRoot, 'package.json'));
  const cargoRaw = readFileIfExists(path.join(projectRoot, 'Cargo.toml'));
  let projectName = path.basename(projectRoot);
  if (pkg && pkg.name) projectName = pkg.name;
  else if (cargoRaw) {
    const m = cargoRaw.match(/\[package\][^[]*?\bname\s*=\s*"([^"]+)"/);
    if (m) projectName = m[1];
  }

  const generalContent = parsedArch
    ? buildGeneralFromSections(projectName, parsedArch)
    : renderGeneralMd(projectRoot, {
        PROJECT_NAME: projectName,
        STACK_SUMMARY: stack.summary,
        DIR_TABLE: dirTable || '_(no top-level dirs detected)_',
        ENV_TABLE: envTable || '_(no env vars found — add as the project grows)_',
        SETUP_COMMANDS: setupCommands || '_(add commands here)_',
        DB_NOTES: dbNotes || '_(no database detected)_',
        COMMANDS_TABLE: commandsTable || '_(no package.json scripts found)_',
      });
  if (generalContent) {
    const res = writeGeneralMdIfMissing(projectRoot, generalContent);
    if (res.written) {
      console.log(`  ${GREEN}Wrote ai/architecture/GENERAL.md${RESET}`);
      try {
        await pushFile(apiBaseUrl, projectId, token, 'ai/architecture/GENERAL.md', generalContent, 1, projectRoot);
      } catch (err) {
        console.log(`  ${YELLOW}Push GENERAL.md skipped: ${err.message}${RESET}`);
      }
    } else {
      console.log(`  ${DIM}ai/architecture/GENERAL.md already exists — keeping.${RESET}`);
    }
  }

  if (!selected.length) {
    console.log(`  ${DIM}No tags selected — skipping tag creation.${RESET}`);
    return { tagsCreated: [], tagsSkipped: [], tagsFailed: [] };
  }

  // Spawn MCP subprocess (loads .env inside Task App dir)
  let mcp;
  try {
    mcp = await spawnMcpClient();
  } catch (err) {
    console.log(`  ${YELLOW}Could not start MCP server: ${err.message}${RESET}`);
    const file = writePendingTags(projectRoot, selected);
    console.log(`  ${DIM}Queued ${selected.length} tag proposal(s) at ${file}. Retry with tipatask-setup.${RESET}`);
    return { pending: file };
  }

  try {
    const result = await createTags(mcp, projectRoot, selected);
    console.log('');
    if (result.created.length) {
      console.log(`  ${GREEN}Created tags:${RESET}`);
      for (const c of result.created) console.log(`    + ${c.tag}`);
    }
    if (result.skipped.length) {
      console.log(`  ${DIM}Tags already existed:${RESET}`);
      for (const s of result.skipped) console.log(`    ~ ${s.tag}`);
    }
    if (result.failed.length) {
      console.log(`  ${YELLOW}Failed tags:${RESET}`);
      for (const f of result.failed) console.log(`    ! ${f.tag}  (${f.error})`);
    }
    const contentByTag = new Map(
      selected.filter((p) => p.content).map((p) => [p.name, p.content])
    );
    if (contentByTag.size && result.created.length) {
      for (const c of result.created) {
        const content = contentByTag.get(c.tag);
        if (!content) continue;
        const tagFile = path.join(projectRoot, 'ai', 'architecture', `${c.tag}.md`);
        let pushedContent = null;
        if (c.file) {
          const fileBody = `# ${c.tag}\n\n${content}\n`;
          fs.writeFileSync(tagFile, fileBody, 'utf8');
          console.log(`  ${GREEN}Populated ${c.tag}.md from ARCHITECTURE.md${RESET}`);
          pushedContent = fileBody;
        } else {
          const r = writeTagMdIfMissing(projectRoot, c.tag, content);
          if (r.written) {
            console.log(`  ${GREEN}Wrote ${c.tag}.md from ARCHITECTURE.md${RESET}`);
            pushedContent = fs.readFileSync(r.path, 'utf8');
          }
        }
        if (pushedContent) {
          try {
            await pushFile(apiBaseUrl, projectId, token, `ai/architecture/${c.tag}.md`, pushedContent, 1, projectRoot);
          } catch (err) {
            console.log(`  ${YELLOW}Push ${c.tag}.md skipped: ${err.message}${RESET}`);
          }
        }
      }
    }

    let seededCount = 0;
    if (result.created.length) {
      const seed = await seedDiscoveryTasks(mcp, result.created.map((c) => c.tag), { apiBaseUrl, token, projectId });
      seededCount = seed.seeded;
      console.log(`  ${GREEN}Seeded ${seededCount} discovery task(s)${RESET}${seed.failed ? `, ${seed.failed} failed` : ''}`);
    }
    return { ...result, seededCount };
  } finally {
    await mcp.close();
  }
}

module.exports = {
  runDiscovery,
  seedDiscoveryTasks,
  parseArchitectureMd,
  buildGeneralFromSections,
  buildTagProposalsFromSections,
  writeTagMdIfMissing,
};
