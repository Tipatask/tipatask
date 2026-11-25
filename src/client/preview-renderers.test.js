import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { LOCALES, setLocale } from './i18n.js';
import { registerPreviewRenderer, renderPreview } from './preview-renderers.js';

const dom = new JSDOM('', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, marked });
afterEach(() => setLocale('en'));

test('a registered kind draws its own content and an unknown kind uses localized fallback copy', () => {
  registerPreviewRenderer('example', preview => document.createTextNode('Value ' + preview.content));
  assert.equal(renderPreview({ kind: 'example', content: 42 }).textContent, 'Value 42');
  for (const [locale, strings] of Object.entries(LOCALES)) {
    setLocale(locale);
    assert.equal(renderPreview({ kind: 'unknown' }).textContent, strings['taskChat.viewer.unsupported']);
    for (const message of ['loading', 'tooLarge', 'notFound', 'forbidden', 'failed']) {
      assert.equal(renderPreview({ message }).textContent, strings['taskChat.viewer.' + message]);
    }
    const partial = renderPreview({ kind: 'text', content: 'abc', truncated: true });
    assert.equal(partial.firstChild.textContent, strings['taskChat.viewer.truncated']);
    assert.equal(partial.querySelector('code').textContent, 'abc');
  }
});

test('Markdown uses reply formatting, source lines are numbered, images and PDFs have dedicated elements', () => {
  const markdown = { kind: 'markdown', content: '# Report\n\n<img onerror=bad()>' };
  assert.equal(renderPreview(markdown).querySelector('h1').textContent, 'Report');
  assert.equal(renderPreview(markdown).querySelector('img'), null);
  const source = renderPreview({ ...markdown, line: 3 });
  assert.equal(source.querySelector('code').textContent, markdown.content);
  assert.equal(source.querySelector('.file-preview-gutter').textContent, '1\n2\n3');
  const image = renderPreview({ kind: 'image', mime: 'image/png', content: 'aQ==', path: 'plot.png' });
  assert.equal(image.src, 'data:image/png;base64,aQ==');
  assert.equal(image.alt, 'plot.png');
  const controller = new AbortController();
  const pdf = renderPreview({ kind: 'pdf', content: btoa('%PDF-1.4'), path: 'report.pdf', signal: controller.signal });
  assert.equal(pdf.tagName, 'IFRAME');
  assert.match(pdf.src, /^blob:/);
  controller.abort();
});
