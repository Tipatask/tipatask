'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ClaudeAgent = require('./claude-agent');
const CodexAgent = require('./codex-agent');
const PiAgent = require('./pi-agent');

function makeProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c1253-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_BASE_URL: 'https://tt.example.test',
    API_TOKEN: 'test-token',
    API_PROJECT_ID: '1',
    CLAUDE_MODEL: 'opusplan',
    CODEX_MODEL: '',
    PI_MODEL: 'openrouter/test-model',
  }), 'utf8');
  return dir;
}

const CONFIG = {
  SIMPLE_MODE: true,
  PROJECT_ROOT: '/fallback/global/project',
  USER_DATA_ROOT: os.tmpdir(),
  CLAUDE_BIN: 'claude',
  CODEX_BIN: 'codex',
};

test('Claude, Codex, and Pi spawn prompts contain local paths instead of inline image data (C1253)', async () => {
  const dir = makeProjectDir();
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const dataUri = `data:image/png;base64,${image.toString('base64')}`;
  const prompt = `Inspect this screenshot: ![screenshot](${dataUri})`;
  const opts = { projectPath: dir };

  try {
    const agents = [new ClaudeAgent(), new CodexAgent(), new PiAgent()];
    const prompts = await Promise.all(agents.map(async (agent) => {
      const localized = await agent.localizeSpawnPrompt(CONFIG, prompt, 'embedded-session', opts);
      return agent.buildPrompt(localized.prompt, localized.opts);
    }));

    for (const agentPrompt of prompts) {
      assert.match(agentPrompt, /screenshot: @.+\.png/);
      assert.doesNotMatch(agentPrompt, /data:image\/png;base64/);
      assert.doesNotMatch(agentPrompt, new RegExp(image.toString('base64')));
    }

    const imageDir = path.join(dir, '.tipatask', 'images', 'embedded-session');
    const files = fs.readdirSync(imageDir).filter(file => file.endsWith('.png'));
    assert.strictEqual(files.length, 3, 'each independent spawn materializes its own local image');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
