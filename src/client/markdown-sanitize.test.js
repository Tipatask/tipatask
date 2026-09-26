import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { marked as realMarked } from 'marked';
import { renderMarkdown } from './utils.js';
import { sanitizeMarkdownHtml } from './markdown-sanitize.js';
import { buildMentionCandidates, highlightMentionsInHtml } from './mention-highlight.js';

function withRenderer(run) {
  const priorWindow = globalThis.window;
  const priorMarked = globalThis.marked;
  const dom = new JSDOM('<div id="output"></div>', { url: 'http://localhost:4455/' });
  globalThis.window = dom.window;
  globalThis.marked = realMarked;
  try {
    const output = dom.window.document.getElementById('output');
    return run({ dom, output });
  } finally {
    dom.window.close();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorMarked === undefined) delete globalThis.marked;
    else globalThis.marked = priorMarked;
  }
}

function assertNoExecutableMarkup(output) {
  assert.equal(output.querySelector('script,svg,math,iframe,object,embed,form'), null);
  for (const element of output.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      assert.doesNotMatch(attribute.name, /^on/i);
      if (attribute.name === 'href' || attribute.name === 'src') {
        assert.match(new URL(attribute.value, 'http://localhost:4455/').protocol, /^(https?:|mailto:)$/);
      }
    }
  }
}

test('real marked output rejects executable and obfuscated link schemes', () => withRenderer(({ output }) => {
  const cases = [
    '[open](javascript:alert%281%29)',
    '[open](data:text/html,%3Cscript%3Ealert(1)%3C/script%3E)',
    '[open](vbscript:msgbox(1))',
    '[open](file:///etc/passwd)',
    '[open](java&#x0a;script:alert(1))',
    '[open](JaVaScRiPt:alert(1))',
    '[open](javascript&#58;alert(1))',
  ];
  for (const input of cases) {
    output.innerHTML = renderMarkdown(input);
    assertNoExecutableMarkup(output);
    assert.equal(output.querySelector('a[href]'), null, input);
    assert.match(output.textContent, /open/);
  }
}));

test('raw HTML, malformed links, SVG, event handlers and encoded schemes stay inert', () => withRenderer(({ output }) => {
  const input = '<svg onload=alert(1)><a href="javascript:alert(1)">svg</a></svg>\n\n'
    + '<img src=x onerror=alert(1)>\n\n'
    + '[broken](javascript:alert(1) "quote><img src=x onerror=alert(1)")';
  output.innerHTML = renderMarkdown(input);
  assertNoExecutableMarkup(output);
  assert.equal(output.querySelector('img'), null, 'raw HTML must display as text');
  assert.match(output.textContent, /<svg onload=alert/);

  output.innerHTML = sanitizeMarkdownHtml('<svg onload="alert(1)"><a href="javascript:alert(1)">x</a></svg>'
    + '<a href="jav&#x61;script:alert(1)" onclick="alert(1)">bad</a>'
    + '<img src="data:image/svg+xml,%3Csvg%3E" onerror="alert(1)">');
  assertNoExecutableMarkup(output);
  assert.equal(output.querySelector('a[href],img[src]'), null);
}));

test('safe links, attachments, code, tables, checkboxes, task links and Unicode text survive', () => withRenderer(({ output }) => {
  const input = [
    '[Docs](https://example.com/path) [Email](mailto:user@example.com) [TPT318](#task-TPT318)',
    '![screenshot](https://web.tipatask.com/api/projects/2/images/4)',
    '[report](https://web.tipatask.com/api/projects/2/files/9)',
    '@src/app.js Український текст',
    '```js\n<script>alert(1)</script>\n```',
    '| Стан | Value |\n| :--- | ---: |\n| Готово | 3 |',
    '- [x] Done',
  ].join('\n\n');
  output.innerHTML = renderMarkdown(input);
  assertNoExecutableMarkup(output);
  assert.equal(output.querySelector('a[href="https://example.com/path"]')?.textContent, 'Docs');
  assert.equal(output.querySelector('a[href="mailto:user@example.com"]')?.textContent, 'Email');
  assert.equal(output.querySelector('a[href="#task-TPT318"]')?.textContent, 'TPT318');
  assert.equal(output.querySelector('img')?.getAttribute('src'), '/api/images/2/4');
  assert.equal(output.querySelector('a.file-attachment-link')?.getAttribute('href'), '/api/files/2/9');
  assert.equal(output.querySelector('span.file-ref')?.textContent, '@src/app.js');
  assert.match(output.textContent, /Український текст/);
  assert.equal(output.querySelector('code.language-js')?.textContent.trim(), '<script>alert(1)</script>');
  assert.equal(output.querySelector('table td')?.textContent, 'Готово');
  assert.equal(output.querySelector('input[type="checkbox"]')?.hasAttribute('disabled'), true);
}));

test('post-render mention highlighting cannot turn a member handle into markup', () => withRenderer(({ output }) => {
  const text = 'Hello @<img src=x onerror=alert(1)> and @Olena';
  const candidates = buildMentionCandidates([
    { id: 1, name: '<img src=x onerror=alert(1)>' },
    { id: 2, name: 'Olena' },
  ]);
  const highlighted = highlightMentionsInHtml(renderMarkdown(text), candidates);
  output.innerHTML = sanitizeMarkdownHtml(highlighted);
  assertNoExecutableMarkup(output);
  assert.equal(output.querySelector('mark.mention')?.textContent, '@<img src=x onerror=alert(1)>');
  assert.equal(output.querySelectorAll('mark.mention').length, 2);
}));
