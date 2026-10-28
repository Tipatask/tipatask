import assert from 'node:assert/strict';
import { test } from 'node:test';

// (TPT9167) Project ▸ Export… toast: every `project:export` frame renders a complete sentence in
// each locale, and one toast carries an export from 'started' to its outcome.
const { LOCALES, setLocale } = await import('./i18n.js');
const { exportToastText, handleProjectExportStatus } = await import('./project-export.js');

const FRAMES = [
  { state: 'started', fileName: 'demo-export.zip' },
  { state: 'done', fileName: 'demo-export.zip', filePath: '/tmp/demo-export.zip', counts: { tasks: 12, kbFiles: 85, sprints: 3 } },
  { state: 'failed', code: 'setup', error: '' },
  { state: 'failed', code: 'auth', error: '' },
  { state: 'failed', code: 'network', error: '' },
  { state: 'failed', code: 'failed', error: 'disk full' },
  { state: 'failed', code: 'failed', error: '' },
];

function fakeToasts() {
  const created = [];
  const showToast = (text) => {
    const toast = { text, outcome: null, closed: false };
    toast.done = (t) => { toast.outcome = ['done', t]; };
    toast.fail = (t) => { toast.outcome = ['fail', t]; };
    toast.close = () => { toast.closed = true; };
    created.push(toast);
    return toast;
  };
  return { created, showToast };
}

test('every export frame renders in every locale with no raw key or unfilled placeholder', () => {
  try {
    for (const locale of Object.keys(LOCALES)) {
      setLocale(locale);
      for (const frame of FRAMES) {
        const text = exportToastText(frame);
        assert.ok(text && !text.startsWith('project.'), `${locale} ${frame.state}/${frame.code}: ${text}`);
        assert.doesNotMatch(text, /\{\w+\}/, `${locale} ${frame.state}/${frame.code}: ${text}`);
      }
      assert.match(exportToastText(FRAMES[1]), /demo-export\.zip/);
      assert.match(exportToastText(FRAMES[1]), /12/);
      assert.match(exportToastText(FRAMES[1]), /85/);
      assert.match(exportToastText(FRAMES[5]), /disk full/);
    }
  } finally {
    setLocale('en');
  }
});

test('the uk table translates the export toasts rather than repeating English', () => {
  for (const key of ['project.exporting', 'project.exportDone', 'project.exportFailed', 'project.exportAuthFailed', 'project.exportOffline', 'project.exportNeedsSetup']) {
    assert.ok(LOCALES.uk[key] && LOCALES.uk[key] !== LOCALES.en[key], `uk ${key}`);
  }
});

test('unknown frames render nothing', () => {
  assert.equal(exportToastText(null), null);
  assert.equal(exportToastText({ state: 'other' }), null);
});

test('one toast follows an export from started to done', () => {
  const { created, showToast } = fakeToasts();
  handleProjectExportStatus(FRAMES[0], { showToast });
  handleProjectExportStatus(FRAMES[1], { showToast });
  assert.equal(created.length, 1);
  assert.equal(created[0].outcome[0], 'done');
  assert.match(created[0].outcome[1], /demo-export\.zip/);
});

test('a failure with no started frame still shows a failed toast', () => {
  const { created, showToast } = fakeToasts();
  handleProjectExportStatus(FRAMES[2], { showToast });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].outcome, ['fail', exportToastText(FRAMES[2])]);
});

test('a new export replaces a progress toast left from an earlier one', () => {
  const { created, showToast } = fakeToasts();
  handleProjectExportStatus(FRAMES[0], { showToast });
  handleProjectExportStatus(FRAMES[0], { showToast });
  handleProjectExportStatus(FRAMES[5], { showToast });
  assert.equal(created.length, 2);
  assert.equal(created[0].closed, true);
  assert.equal(created[1].outcome[0], 'fail');
});
