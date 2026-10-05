'use strict';
const fs = require('node:fs');
const path = require('node:path');

// System settings outrank project/user settings. Gemini is a proposal-only
// provider: no Tipatask API credentials, MCP, extensions, shell or edit tools.
function prepareGeminiSettings(userDataRoot) {
  const dir = path.join(userDataRoot, 'gemini-objective');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  const content = JSON.stringify({
    tools: { core: ['read_file', 'read_many_files', 'list_directory', 'glob', 'grep_search'],
      allowed: ['read_file', 'read_many_files', 'list_directory', 'glob', 'grep_search'],
      discoveryCommand: '', callCommand: '' },
    admin: { extensions: { enabled: false }, mcp: { enabled: false }, skills: { enabled: false } },
    mcp: { allowed: [] },
    security: { disableYoloMode: true },
    context: { fileName: ['AGENTS.md', 'GEMINI.md'] },
    useWriteTodos: false,
  }, null, 2) + '\n';
  let previous; try { previous = fs.readFileSync(file, 'utf8'); } catch { /* first launch */ }
  if (previous !== content) fs.writeFileSync(file, content);
  return file;
}
module.exports = { prepareGeminiSettings };
