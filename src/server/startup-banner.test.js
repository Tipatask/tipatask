'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildStartupBannerLines } = require('./startup-banner');

const config = { PORT: 4455, TASK_AGENT: 'claude', API_PROJECT_ID: 7, API_BASE_URL: 'https://api.example' };

test('banner flags a bare server start as browser/debug mode', () => {
  const text = buildStartupBannerLines({ config, version: '1.2.3', env: {} }).join('\n');
  assert.match(text, /Mode\s+: browser \/ debug/);
  assert.match(text, /desktop app/);
  assert.match(text, /Version : v1\.2\.3/);
  assert.match(text, /Board   : http:\/\/127\.0\.0\.1:4455\/todo\.html/);
});

test('banner reports desktop-app mode when forked by Electron', () => {
  const text = buildStartupBannerLines({ config, version: '1.2.3', env: { TIPATASK_ELECTRON_HOST: '1' } }).join('\n');
  assert.match(text, /Mode\s+: desktop app/);
  assert.doesNotMatch(text, /browser \/ debug/);
});
