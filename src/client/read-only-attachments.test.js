import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Marked } from 'marked';
import {
  attachmentFromUrl, escapeHtml, fileChipHtml, imageBlockHtml, tidyImageBlocks,
} from './attachment-markup.js';
import { renderMarkdown } from './utils.js';
import { sanitizeMarkdownHtml } from './markdown-sanitize.js';
import { ensureFileLinkHandler } from './file-attach.js';

// (TPT9411) Read-only text shows every attachment in place: an image as a block on lines of its
// own, an uploaded file or project artifact as a chip with its name in the line of text. The
// markup is attachment-markup.js's, used by renderMarkdown() (descriptions, comments, chat replies)
// and by a chat user turn (task-chat-model.js userMessageHtml(), covered by its own tests).

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const styles = read('./styles.css');

// The stylesheet's own read-only attachment rules, cut out by structure: from their section
// comment to the end of its forced-colours block.
function attachmentRules() {
  const start = styles.indexOf('/* ── Read-only attachments (TPT9411)');
  assert.ok(start >= 0, 'the Read-only attachments section exists');
  const forced = styles.indexOf('@media (forced-colors: active) {', start);
  assert.ok(forced > start, 'it ends with its forced-colours rules');
  return styles.slice(start, styles.indexOf('\n}\n', forced) + 3);
}

// A renderer window with the real marked and the section's CSS, like the Task App page.
function withPage(run) {
  const priorWindow = globalThis.window;
  const priorMarked = globalThis.marked;
  const dom = new JSDOM(`<!doctype html><html><head><style>${attachmentRules()}</style></head><body><div id="output"></div></body></html>`,
    { url: 'http://localhost:4455/todo.html' });
  globalThis.window = dom.window;
  globalThis.marked = new Marked();
  try {
    return run({ dom, output: dom.window.document.getElementById('output') });
  } finally {
    dom.window.close();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorMarked === undefined) delete globalThis.marked;
    else globalThis.marked = priorMarked;
  }
}

// A paragraph's children as [kind, detail] pairs, in document order.
function flow(parent) {
  return [...parent.childNodes].map((n) => {
    if (n.nodeType === 3) return ['text', n.textContent];
    if (n.classList.contains('md-image')) return ['image', n.querySelector(':scope > img').getAttribute('src')];
    if (n.classList.contains('file-attachment-link')) return ['file', n.getAttribute('href')];
    return [n.tagName.toLowerCase(), n.getAttribute('href')];
  });
}

test('attachmentFromUrl: uploaded images, files and artifact revisions at their same-origin address; nothing else', () => {
  assert.deepEqual(attachmentFromUrl('http://127.0.0.1:4454/api/projects/2/images/41'), { kind: 'image', src: '/api/images/2/41', href: '/api/images/2/41' });
  assert.deepEqual(attachmentFromUrl('https://web.tipatask.com/api/projects/2/files/7?v=1#L12'), { kind: 'file', href: '/api/files/2/7#L12', artifact: false });
  assert.deepEqual(attachmentFromUrl('/api/files/2/7'), { kind: 'file', href: '/api/files/2/7', artifact: false });
  assert.deepEqual(attachmentFromUrl('/api/projects/2/files/artifacts/11/revisions/3/content'),
    { kind: 'file', href: '/api/projects/2/files/artifacts/11/revisions/3/content', artifact: true });
  for (const other of ['https://example.com/x.png', 'reports/check.sql#L2', 'blob:http://localhost:4455/1', 'javascript:alert(1)', '', null]) {
    assert.equal(attachmentFromUrl(other), null, String(other));
  }
});

test('escapeHtml keeps entity references and escapes everything else', () => {
  assert.equal(escapeHtml(`a & b &amp; <c> "d" 'e' &#39; &#x3C;`), 'a &amp; b &amp; &lt;c&gt; &quot;d&quot; &#39;e&#39; &#39; &#x3C;');
  assert.equal(escapeHtml(null), '');
});

test('the image block and the file chip markup', () => {
  assert.equal(imageBlockHtml({ src: '/api/images/2/41', alt: 'chart "Q3"' }),
    '<span class="md-image"><img src="/api/images/2/41" alt="chart &quot;Q3&quot;" loading="lazy"></span>');
  assert.equal(imageBlockHtml({ src: 'https://e.test/a.png', alt: 'a', title: 'T' }),
    '<span class="md-image"><img src="https://e.test/a.png" alt="a" title="T" loading="lazy"></span>');
  assert.equal(fileChipHtml({ href: '/api/files/2/7', name: 'r&d.pdf' }),
    '<a class="file-attachment-link" href="/api/files/2/7" title="r&amp;d.pdf"><span class="file-attachment-icon"></span>'
    + '<span class="file-attachment-name">r&amp;d.pdf</span></a>');
  assert.equal(fileChipHtml({ href: '/api/projects/2/files/artifacts/1/revisions/2/content', nameHtml: '<strong>s</strong>', title: 's', artifact: true }),
    '<a class="file-attachment-link" href="/api/projects/2/files/artifacts/1/revisions/2/content" title="s" download>'
    + '<span class="file-attachment-icon"></span><span class="file-attachment-name"><strong>s</strong></span></a>');
  assert.equal(fileChipHtml({ href: '/api/files/2/7', name: '', title: '' }).includes('title='), false);
});

test('tidyImageBlocks takes the line break and blanks next to an image block, and nothing else', () => {
  const block = '<span class="md-image"><img src="/api/images/2/4" alt="" loading="lazy"></span>';
  assert.equal(tidyImageBlocks(`<p>a <br>\n${block}<br> b</p>`), `<p>a${block}b</p>`);
  assert.equal(tidyImageBlocks(`<p>${block}<br>${block}</p>`), `<p>${block}${block}</p>`, 'two images, one per line');
  assert.equal(tidyImageBlocks('<p>a<br>b <span class="file-ref">@x.js</span></p>'), '<p>a<br>b <span class="file-ref">@x.js</span></p>');
});

test('renderMarkdown: an image written mid-sentence renders as a block on lines of its own', () => withPage(({ dom, output }) => {
  output.innerHTML = renderMarkdown('Look at this ![chart](http://127.0.0.1:4454/api/projects/2/images/41) and tell me why\n'
    + '![shot](https://web.tipatask.com/api/projects/2/images/42)\nmore');
  const p = output.querySelector('p');
  assert.deepEqual(flow(p), [
    ['text', 'Look at this'],
    ['image', '/api/images/2/41'],
    ['text', 'and tell me why'],
    ['image', '/api/images/2/42'],
    ['text', 'more'],
  ]);
  assert.equal(output.querySelector('br'), null, 'no line break next to an image: the block makes its own lines');
  const block = p.querySelector('.md-image');
  assert.equal(dom.window.getComputedStyle(block).display, 'flex', 'a block-level box: it starts on a new line');
  const img = block.querySelector('img');
  assert.equal(img.getAttribute('alt'), 'chart');
  assert.equal(img.getAttribute('loading'), 'lazy');
  // In a list item, a table cell or a quote the same way.
  output.innerHTML = renderMarkdown('- item ![x](https://e.test/a.png) tail\n\n> quote ![q](/api/images/2/43) end');
  assert.deepEqual(flow(output.querySelector('li')), [['text', 'item'], ['image', 'https://e.test/a.png'], ['text', 'tail']]);
  assert.deepEqual(flow(output.querySelector('blockquote p')), [['text', 'quote'], ['image', '/api/images/2/43'], ['text', 'end']]);
}));

test('renderMarkdown: a file link stays inline as a chip with its name, at the same-origin address', () => withPage(({ dom, output }) => {
  output.innerHTML = renderMarkdown('See [spec.pdf](http://127.0.0.1:4454/api/projects/2/files/7) and [**Spec** v2](/api/projects/2/files/8#L12 "Spec, v2") now.');
  const p = output.querySelector('p');
  assert.deepEqual(flow(p), [
    ['text', 'See '],
    ['file', '/api/files/2/7'],
    ['text', ' and '],
    ['file', '/api/files/2/8#L12'],
    ['text', ' now.'],
  ]);
  const [spec, v2] = p.querySelectorAll('a.file-attachment-link');
  assert.equal(spec.querySelector('.file-attachment-name').textContent, 'spec.pdf');
  assert.equal(spec.getAttribute('title'), 'spec.pdf');
  assert.equal(spec.querySelector('.file-attachment-icon').textContent, '', 'the icon is drawn by CSS');
  assert.equal(v2.querySelector('.file-attachment-name').innerHTML, '<strong>Spec</strong> v2');
  assert.equal(v2.getAttribute('title'), 'Spec, v2');
  assert.equal(dom.window.getComputedStyle(spec).display, 'inline-flex', 'an inline box in the line of text');
  // A project artifact is a chip too, downloading in its window.
  output.innerHTML = renderMarkdown('[survey · r3](/api/projects/2/files/artifacts/11/revisions/3/content) and [line](/api/projects/2/files/artifacts/11/revisions/3/content#L4)');
  const artifacts = output.querySelectorAll('a.file-attachment-link');
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0].hasAttribute('download'), true);
  assert.equal(artifacts[0].textContent, 'survey · r3');
  assert.equal(artifacts[1].hasAttribute('download'), true, 'a line anchor keeps the in-window download');
}));

test('renderMarkdown: the URL decides — a link to an image is an image, image syntax naming a file is a chip, other links stay links', () => withPage(({ output }) => {
  output.innerHTML = renderMarkdown('[chart](/api/images/2/5) ![a.pdf](/api/projects/2/files/9) '
    + '[docs](https://example.com/api/projects/x) [check.sql](reports/check.sql#L2) ![ext](https://e.test/b.png)');
  assert.deepEqual(flow(output.querySelector('p')), [
    ['image', '/api/images/2/5'],
    ['file', '/api/files/2/9'],
    ['text', ' '],
    ['a', 'https://example.com/api/projects/x'],
    ['text', ' '],
    ['a', 'reports/check.sql#L2'],
    ['image', 'https://e.test/b.png'],
  ]);
  assert.equal(output.querySelector('a[href="https://example.com/api/projects/x"]').className, '', 'a web link keeps marked\'s markup');
  assert.equal(output.querySelector('.md-image img').getAttribute('alt'), 'chart');
  // An escaped name and an image whose address cannot be read stay inert text.
  output.innerHTML = renderMarkdown('![x" onerror="alert(1)](https://e.test/x.png)');
  assert.equal(output.querySelector('img').getAttribute('alt'), 'x" onerror="alert(1)');
  assert.equal(output.querySelector('img').getAttribute('onerror'), null);
}));

test('the sanitizer keeps the attachment classes and lazy loading, and nothing more', () => withPage(({ output }) => {
  output.innerHTML = sanitizeMarkdownHtml('<span class="md-image evil"><img src="https://x.test/a.png" loading="lazy"></span>'
    + '<img src="https://x.test/b.png" loading="eager"><a href="https://x.test/" loading="lazy">x</a>'
    + '<a class="file-attachment-link" href="/api/files/2/7"><span class="file-attachment-icon"></span><span class="file-attachment-name">n</span></a>');
  assert.equal(output.querySelector('span').className, 'md-image');
  const [lazy, eager] = output.querySelectorAll('img');
  assert.equal(lazy.getAttribute('loading'), 'lazy');
  assert.equal(eager.hasAttribute('loading'), false);
  assert.equal(output.querySelector('a[href="https://x.test/"]').hasAttribute('loading'), false);
  assert.ok(output.querySelector('a.file-attachment-link > span.file-attachment-icon + span.file-attachment-name'));
}));

test('a file chip still downloads: the click goes to the system browser; an artifact downloads in the window', () => withPage(({ dom, output }) => {
  const priorDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const opened = [];
  dom.window.electronAPI = { openExternal: href => opened.push(href) };
  try {
    ensureFileLinkHandler();
    // Runs after the handler: records what it left, then stops jsdom's own navigation.
    let prevented = null;
    dom.window.document.addEventListener('click', (e) => { prevented = e.defaultPrevented; e.preventDefault(); });
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    output.innerHTML = renderMarkdown('Read [notes.txt](https://web.tipatask.com/api/projects/2/files/7) first, then '
      + '[survey · r3](/api/projects/2/files/artifacts/11/revisions/3/content).');
    const [file, artifact] = output.querySelectorAll('a.file-attachment-link');
    click(file.querySelector('.file-attachment-name'));
    assert.equal(prevented, true, 'the app does not navigate itself');
    assert.deepEqual(opened, ['http://localhost:4455/api/files/2/7'], 'the same-origin proxy downloads it');
    click(artifact.querySelector('.file-attachment-icon'));
    assert.equal(prevented, false, 'left to the window: the artifact needs its project session');
    assert.equal(opened.length, 1);
  } finally {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }
}));

test('styles.css: the image block, the chip and their surfaces', () => {
  const rules = attachmentRules();
  assert.match(rules, /\n\.md-image \{\n {2}display: flex;/);
  assert.match(rules, /\na\.file-attachment-link \{\n {2}display: inline-flex;/);
  assert.match(rules, /\.file-attachment-icon \{[^}]*mask: url\("data:image\/svg\+xml,[^"]+"\) center \/ contain no-repeat;/);
  assert.match(rules, /a\.file-attachment-link\[download\] \.file-attachment-icon \{/);
  assert.match(rules, /@media \(forced-colors: active\) \{[^}]*a\.file-attachment-link \{ border-color: LinkText; \}/);
  assert.doesNotMatch(styles, /\.file-attachment-link::before/, 'the paperclip marker is gone');
  // A collapsed reply citation shows one line of text: its image blocks wait for Show quote.
  assert.match(styles, /\.comment-citation:not\(\.is-expanded\) \.comment-citation-text \.md-image \{ display: none; \}/);
});

test('every surface draws the shared markup: the pending description image, the objective chat user bubble', () => {
  const modal = read('./task-edit-modal.js');
  const pending = modal.slice(modal.indexOf('function _withPendingImages('), modal.indexOf('\n}\n', modal.indexOf('function _withPendingImages(')));
  assert.match(pending, /<span class="md-image"><img class="modal-desc-pending-image" src="\$\{escapeAttr\(url\)\}" alt=""><\/span>/);
  assert.match(pending, /tidyImageBlocks\(html\)/);
  const chat = read('./chat-ui.js');
  const render = chat.slice(chat.indexOf('export function renderObjectiveContent('), chat.indexOf('export function refreshObjectiveContent('));
  assert.match(render, /<div class="chat-bubble-body">\$\{userMessageHtml\(msg\.content, \{ t \}\)\}<\/div>/);
  const attach = chat.slice(chat.indexOf('export function attachChatHandlers('));
  assert.match(attach, /chatMessagesEl\.addEventListener\('load', \(e\) => \{\s*if \(e\.target && e\.target\.tagName === 'IMG'\) syncBubbleClamps\(\);\s*\}, true\);/,
    'an image that loads later re-measures the bubble clamps');
});
