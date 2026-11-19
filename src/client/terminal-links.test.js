import test from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/xterm';
import { trimUrlMatch, findPlainUrls, plainUrlLinks, registerPlainUrlLinks } from './terminal-links.js';

const { Terminal } = xterm;

async function terminal(output, { cols = 20, rows = 8 } = {}) {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise(resolve => term.write(output, resolve));
  return term;
}

function linksOn(term, row) {
  const activations = [];
  const links = plainUrlLinks(term, row, (event, uri) => activations.push(uri));
  return { links, activations };
}

test('trailing sentence punctuation and unopened closing brackets stay outside the URL', () => {
  assert.equal(trimUrlMatch('https://example.com/a.'), 'https://example.com/a');
  assert.equal(trimUrlMatch('https://example.com/a?!'), 'https://example.com/a');
  assert.equal(trimUrlMatch('https://example.com/a),'), 'https://example.com/a');
  assert.equal(trimUrlMatch('https://en.wikipedia.org/wiki/Bash_(Unix_shell)'),
    'https://en.wikipedia.org/wiki/Bash_(Unix_shell)');
  assert.equal(trimUrlMatch('https://example.com/?a[]=1]'), 'https://example.com/?a[]=1');
  assert.equal(trimUrlMatch('https://example.com/path/'), 'https://example.com/path/');
});

test('findPlainUrls keeps query and fragment and skips other schemes', () => {
  const text = 'Open https://photoassistant.net/dashboard/database?tab=all&next=%2Fdb#tables, '
    + '"http://127.0.0.1:4455/download?name=%22x%22" (see https://example.com/a). '
    + 'ftp://example.com/x javascript:alert(1) file:///etc/passwd mailto:a@b.c https:// http://.';
  assert.deepEqual(findPlainUrls(text).map(match => match.url), [
    'https://photoassistant.net/dashboard/database?tab=all&next=%2Fdb#tables',
    'http://127.0.0.1:4455/download?name=%22x%22',
    'https://example.com/a',
  ]);
  const [first] = findPlainUrls(text);
  assert.equal(text.slice(first.start, first.end), first.url);
});

test('findPlainUrls stops at TUI borders and skips URLs a program cut with an ellipsis', () => {
  assert.deepEqual(findPlainUrls('│ https://example.com/ok│ <https://example.com/angle>').map(m => m.url),
    ['https://example.com/ok', 'https://example.com/angle']);
  assert.deepEqual(findPlainUrls('see https://example.com/very/long/pa… and https://example.com/b.…'), []);
});

test('a URL the terminal soft-wrapped links whole from every row it covers', async () => {
  const url = 'https://example.com/abcdefghij?x=1&y=two#frag';
  const term = await terminal(`see ${url} ok`);
  assert.equal(term.buffer.active.getLine(1).isWrapped, true);
  for (const row of [1, 2, 3]) {
    const { links, activations } = linksOn(term, row);
    assert.equal(links.length, 1, `row ${row}`);
    assert.equal(links[0].text, url);
    assert.deepEqual(links[0].range, { start: { x: 5, y: 1 }, end: { x: 9, y: 3 } });
    links[0].activate({}, links[0].text);
    assert.deepEqual(activations, [url]);
  }
  term.dispose();
});

test('a URL a program hard-wrapped itself is never linked truncated', async () => {
  // Exactly fills row 1, then the program moves to the next row itself (CR LF, no soft wrap).
  const head = 'https://example.com/';
  const cases = [`${head}\r\nabcdef?x=1 ok`, `${head}\r\n  abcdef?x=1 ok`];
  for (const output of cases) {
    const term = await terminal(output);
    assert.equal(term.buffer.active.getLine(1).isWrapped, false);
    assert.deepEqual(linksOn(term, 1).links, [], JSON.stringify(output));
    assert.deepEqual(linksOn(term, 2).links, [], JSON.stringify(output));
    term.dispose();
  }
  // Trailing punctuation at the edge does not hide the possible continuation.
  const dotted = await terminal('https://example.c/a.\r\nb/c ok'); // exactly 20 columns
  assert.deepEqual(linksOn(dotted, 1).links, []);
  dotted.dispose();
  // A URL that ends exactly at the edge before a blank or non-URL row is complete.
  for (const output of [`${head}\r\n\r\nnext`, `${head}\r\n│ box`]) {
    const term = await terminal(output);
    assert.deepEqual(linksOn(term, 1).links.map(link => link.text), [head], JSON.stringify(output));
    term.dispose();
  }
});

test('link ranges count wide characters as two cells', async () => {
  const term = await terminal('漢字 https://x.co/a b', { cols: 40 });
  const { links } = linksOn(term, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, 'https://x.co/a');
  assert.deepEqual(links[0].range, { start: { x: 6, y: 1 }, end: { x: 19, y: 1 } });
  term.dispose();
});

test('a URL cut by the scan window is not linked, a whole one beside it still is', async () => {
  // 3020 cells: rows 1-151 of one soft-wrapped line; the short URL follows on rows 152-153.
  const longUrl = `https://example.com/${'a'.repeat(3000)}`;
  const term = await terminal(`${longUrl} https://example.com/short`, { cols: 20, rows: 200 });
  for (const row of [1, 75, 151]) assert.deepEqual(linksOn(term, row).links, [], `row ${row}`);
  for (const row of [152, 153]) {
    assert.deepEqual(linksOn(term, row).links.map(link => link.text), ['https://example.com/short'], `row ${row}`);
  }
  term.dispose();
});

test('registerPlainUrlLinks routes provider links to the shared handler', async () => {
  assert.equal(registerPlainUrlLinks({}, { activate() {} }), null, 'terminal without link providers');
  const term = await terminal('plain https://example.com/?q=1#top\r\nnothing here', { cols: 40 });
  const providers = [];
  term.registerLinkProvider = provider => { providers.push(provider); return { dispose() {} }; };
  const activated = [];
  assert.ok(registerPlainUrlLinks(term, { activate: (event, uri) => activated.push(uri) }));
  const reply = row => new Promise(resolve => providers[0].provideLinks(row, resolve));
  assert.equal(await reply(2), undefined);
  const [link] = await reply(1);
  link.activate({}, link.text);
  assert.deepEqual(activated, ['https://example.com/?q=1#top']);
  term.dispose();
});
