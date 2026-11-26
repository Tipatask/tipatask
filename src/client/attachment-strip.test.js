// (TPT9410) The attachment strip under every textarea that takes attachments (embed-menu.js):
// which references of the text count as attachments, how a reference leaves the text, and the
// strip itself in a DOM — mounted after the field, following its text, keeping a tile across an
// upload's placeholder-to-URL swap, × and click on a tile, and the accent border of the tile whose
// reference is under the pointer (syncStripHover()). Geometry is stubbed here: happy-dom lays
// nothing out, so the mirror's span rectangles come from a table keyed by the reference's text.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:4455/' });
for (const key of [
  'document', 'location', 'Event', 'MouseEvent', 'KeyboardEvent', 'HTMLElement', 'Node',
  'getComputedStyle', 'localStorage', 'sessionStorage',
]) Object.defineProperty(globalThis, key, { value: window[key], configurable: true });
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { value: window, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });

const { attachmentRefs, textWithoutRanges, renderAttachmentStrip, syncStripHover } = await import('./embed-menu.js');

after(async () => { await window.happyDOM.abort(); });

const API = 'http://127.0.0.1:4454/api/projects/2';
const ORIGIN = 'http://localhost:4455';
const image = id => `![img](${API}/images/${id})`;
const file = (name, id) => `[${name}](${API}/files/${id})`;

// ── attachmentRefs() ──

test('images, files and artifacts are attachments; their keys are the same-origin addresses', () => {
  const text = [
    `Intro ${image(9)} after`,
    `![diagram.png](/api/projects/2/images/10)`,
    file('spec.pdf', 45),
    '[notes\\[1\\].md · r3](/api/projects/2/files/artifacts/7/revisions/3/content)',
  ].join('\n');
  const refs = attachmentRefs(text, { origin: ORIGIN });
  assert.deepEqual(refs.map(r => [r.kind, r.key, r.name]), [
    ['image', '/api/images/2/9', ''],
    ['image', '/api/images/2/10', 'diagram.png'],
    ['file', '/api/files/2/45', 'spec.pdf'],
    ['file', '/api/projects/2/files/artifacts/7/revisions/3/content', 'notes[1].md'],
  ]);
  assert.equal(refs[0].src, '/api/images/2/9', 'thumbnails load through the Task App proxy');
  assert.deepEqual([refs[3].artifact, refs[3].revision], [true, 3]);
  assert.deepEqual([refs[2].artifact, refs[2].revision], [false, null]);
  for (const ref of refs) {
    for (const [start, end] of ref.ranges) assert.match(text.slice(start, end), /^!?\[.*\]\(.*\)$/);
  }
  assert.equal(text.slice(...refs[0].ranges[0]), image(9));
});

test('every reference to one attachment is one entry, in the order of the first', () => {
  const text = `${file('spec.pdf', 45)} and ${image(9)}\n[spec.pdf](/api/projects/2/files/45#L12)\n[spec](/api/files/2/45)`;
  const refs = attachmentRefs(text, { origin: ORIGIN });
  assert.deepEqual(refs.map(r => r.key), ['/api/files/2/45', '/api/images/2/9']);
  assert.equal(refs[0].ranges.length, 3);
  assert.equal(refs[0].name, 'spec.pdf', 'the first reference names it');
});

test('an uploading image is pending only from this page; Trello images count; other links do not', () => {
  const own = `![img](blob:${ORIGIN}/0f3a)`;
  const foreign = '![img](blob:http://elsewhere.test/77aa)';
  const trello = '![card.png](/api/trello/image-proxy?url=https%3A%2F%2Ftrello.com%2F1%2Fcards%2Fa%2Fdownload%2Fb.png)';
  const others = '[docs](https://example.com/a) ![x](https://example.com/x.png) [src](src/client/a.js) [](/api/images/2/x)';
  const refs = attachmentRefs([own, foreign, trello, others].join('\n'), { origin: ORIGIN });
  assert.deepEqual(refs.map(r => [r.kind, r.pending, r.name]), [['image', true, ''], ['image', false, 'card.png']]);
  assert.deepEqual(attachmentRefs(own, { origin: null }), [], 'no origin, no own blob URL');
  assert.deepEqual(attachmentRefs(''), []);
  assert.deepEqual(attachmentRefs(null), []);
});

// ── textWithoutRanges() ──

test('a reference alone on its line takes the line break; between words one space', () => {
  const only = (text, ref) => {
    const at = text.indexOf(ref);
    return textWithoutRanges(text, [[at, at + ref.length]]).text;
  };
  const ref = image(9);
  assert.equal(only(`one\n${ref}\ntwo`, ref), 'one\ntwo');
  assert.equal(only(`one\n${ref}`, ref), 'one');
  assert.equal(only(ref, ref), '');
  assert.equal(only(`a ${ref} b`, ref), 'a b');
  assert.equal(only(`text ${ref}`, ref), 'text');
  assert.equal(only(`${ref} text`, ref), 'text');
  assert.equal(only(`a${ref}b`, ref), 'ab');
});

test('several references go at once, adjacent lines merged, and offsets follow', () => {
  const a = image(1);
  const b = file('x.txt', 2);
  const text = `head\n${a}\n${b}\ntail ${a} end`;
  const ranges = [];
  let at = -1;
  while ((at = text.indexOf(a, at + 1)) >= 0) ranges.push([at, at + a.length]);
  ranges.push([text.indexOf(b), text.indexOf(b) + b.length]);
  const { text: out, spans, map } = textWithoutRanges(text, ranges);
  assert.equal(out, 'head\ntail end');
  assert.equal(spans.length, 2, 'the two lines are one span');
  assert.equal(map(2), 2, 'before: unchanged');
  assert.equal(map(text.indexOf(a) + 3), 5, 'inside: where the span was');
  assert.equal(map(text.length), out.length, 'after: shifted by what went');
});

// ── The strip in a DOM ──

function field(value, { wrap = false } = {}) {
  const host = document.createElement('div');
  host.innerHTML = wrap
    ? '<div class="audio-rec-wrap"><button class="audio-rec-btn"></button><textarea></textarea></div><div class="after"></div>'
    : '<textarea></textarea><div class="after"></div>';
  document.body.appendChild(host);
  const ta = host.querySelector('textarea');
  ta.value = value;
  return { host, ta };
}
const tiles = strip => [...strip.querySelectorAll('.attachment-tile')];
const type = (ta, value) => {
  ta.value = value;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
};

test('the strip mounts after the field (or its mic wrap) and shows a tile per attachment', () => {
  const { host, ta } = field(`Look ${image(9)}\n${file('spec.pdf', 45)}\n[plan.md · r2](/api/projects/2/files/artifacts/4/revisions/2/content)`);
  const strip = renderAttachmentStrip(ta);
  assert.equal(ta.nextElementSibling === strip, true);
  assert.equal(strip.getAttribute('role'), 'list');
  assert.equal(strip.getAttribute('aria-label'), 'Attachments');
  assert.equal(strip.hidden, false);
  const [img, pdf, artifact] = tiles(strip);
  assert.ok(img.classList.contains('attachment-tile--image'));
  assert.equal(img.querySelector('img').getAttribute('src'), '/api/images/2/9');
  assert.equal(img.title, 'Image');
  assert.equal(img.getAttribute('role'), 'listitem');
  assert.equal(pdf.querySelector('.attachment-tile-name').textContent, 'spec.pdf');
  assert.equal(pdf.querySelector('.attachment-tile-kind').textContent, 'PDF');
  assert.equal(pdf.querySelector('.attachment-tile-remove').getAttribute('aria-label'), 'Remove spec.pdf');
  assert.equal(artifact.querySelector('.attachment-tile-name').textContent, 'plan.md');
  assert.equal(artifact.querySelector('.attachment-tile-kind').textContent, 'Project artifact · r2');
  assert.equal(artifact.title, 'plan.md · r2');
  assert.equal(renderAttachmentStrip(ta) === strip, true, 'a second call updates the same strip');
  assert.equal(host.querySelectorAll('.attachment-strip').length, 1);

  const wrapped = field(image(3), { wrap: true });
  const after = renderAttachmentStrip(wrapped.ta);
  assert.equal(wrapped.host.querySelector('.audio-rec-wrap').nextElementSibling === after, true);
  const inside = field(image(3), { wrap: true });
  const box = inside.host.querySelector('.audio-rec-wrap');
  assert.equal(renderAttachmentStrip(inside.ta, { container: box }).parentElement === box, true);
});

test('tiles follow the text: kept while their reference stays, dropped when it goes', () => {
  const { ta } = field('');
  const strip = renderAttachmentStrip(ta);
  assert.equal(strip.hidden, true, 'nothing referenced, nothing shown');
  type(ta, `${image(9)}\n${file('a.txt', 1)}`);
  const [first, second] = tiles(strip);
  type(ta, `${image(9)}\n${file('a.txt', 1)}\n${file('b.csv', 2)}\n${image(9)}`);
  assert.equal(tiles(strip).length, 3, 'the repeated image is one tile');
  assert.equal(tiles(strip)[0] === first && tiles(strip)[1] === second, true, 'existing tiles are kept, not rebuilt');
  type(ta, `${file('b.csv', 2)}\n${file('a.txt', 1)}`);
  assert.deepEqual(tiles(strip).map(t => t.querySelector('.attachment-tile-name').textContent), ['b.csv', 'a.txt']);
  assert.equal(tiles(strip)[1] === second, true);
  type(ta, 'all gone');
  assert.equal(tiles(strip).length, 0);
  assert.equal(strip.hidden, true);
  // A write without an input event shows on focus, or when the host calls it again.
  ta.value = image(5);
  ta.dispatchEvent(new window.FocusEvent('focus'));
  assert.equal(tiles(strip).length, 1);
  ta.value = '';
  renderAttachmentStrip(ta);
  assert.equal(strip.hidden, true);
});

test('an upload that lands keeps its tile: the placeholder tile turns into the image', () => {
  const { ta } = field('');
  const strip = renderAttachmentStrip(ta);
  const blob = `blob:${ORIGIN}/9d2c`;
  type(ta, `before ![img](${blob}) after`);
  const [tile] = tiles(strip);
  assert.ok(tile.classList.contains('attachment-tile--pending'));
  assert.equal(tile.title, 'Image — uploading…');
  assert.equal(tile.querySelector('img').getAttribute('src'), blob);
  type(ta, `before ${image(12)} after`);
  assert.equal(tiles(strip)[0] === tile, true, 'the same tile');
  assert.equal(tile.classList.contains('attachment-tile--pending'), false);
  assert.equal(tile.dataset.key, '/api/images/2/12');
  assert.equal(tile.querySelector('img').dataset.src, '/api/images/2/12');
  tile.querySelector('img').dispatchEvent(new Event('error'));
  assert.ok(tile.classList.contains('attachment-tile--broken'), 'an image that cannot load shows a placeholder');
  tile.querySelector('img').dispatchEvent(new Event('load'));
  assert.equal(tile.classList.contains('attachment-tile--broken'), false);
});

test('× takes every reference of its attachment out of the text; the caret stays on its text', () => {
  const ref = file('spec.pdf', 45);
  const { ta } = field(`Intro\n${ref}\nmiddle ${ref} end\n${image(9)}`);
  const strip = renderAttachmentStrip(ta);
  const inputs = [];
  ta.addEventListener('input', () => inputs.push(ta.value));
  const caret = ta.value.indexOf('middle') + 3;
  ta.setSelectionRange(caret, caret);
  const remove = tiles(strip)[0].querySelector('.attachment-tile-remove');
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  remove.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true, 'pressing × leaves the focus where it is');
  remove.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(ta.value, `Intro\nmiddle end\n${image(9)}`);
  assert.equal(inputs.length > 0, true, 'the host hears an input event');
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [9, 9]);
  assert.equal(tiles(strip).length, 1);
  // From the keyboard the focus moves on before the tile goes: the field after the last one.
  const last = tiles(strip)[0].querySelector('.attachment-tile-remove');
  last.focus();
  last.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(ta.value, 'Intro\nmiddle end');
  assert.equal(document.activeElement === ta, true);
  assert.equal(strip.hidden, true);
});

test('keyboard removal moves the focus to the next tile; a locked field keeps its references', () => {
  const { ta } = field(`${image(1)} ${image(2)} ${image(3)}`);
  const strip = renderAttachmentStrip(ta);
  const middle = tiles(strip)[1].querySelector('.attachment-tile-remove');
  const next = tiles(strip)[2].querySelector('.attachment-tile-remove');
  middle.focus();
  middle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(ta.value, `${image(1)} ${image(3)}`);
  assert.equal(document.activeElement === next, true);

  ta.disabled = true;
  renderAttachmentStrip(ta);
  assert.ok(strip.classList.contains('attachment-strip--locked'));
  next.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(ta.value, `${image(1)} ${image(3)}`, 'disabled: × does nothing');
  ta.disabled = false;
  renderAttachmentStrip(ta);
  assert.equal(strip.classList.contains('attachment-strip--locked'), false);
});

test('a click on a tile selects its reference in the text', () => {
  const ref = file('a.txt', 1);
  const { ta } = field(`one ${image(9)} two ${ref}`);
  const strip = renderAttachmentStrip(ta);
  tiles(strip)[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(document.activeElement === ta, true);
  assert.equal(ta.value.slice(ta.selectionStart, ta.selectionEnd), ref);
});

// ── syncStripHover() ──

// Lays out a field 300×100 at (10, 20), and each reference's mirror span at the rectangles given
// for its text, relative to the field's text (unscrolled).
function laidOut(value, layout) {
  const { ta } = field(value);
  ta.getBoundingClientRect = () => ({ left: 10, top: 20, right: 310, bottom: 120, width: 300, height: 100 });
  for (const [name, size] of [['clientWidth', 300], ['clientHeight', 100], ['clientLeft', 0], ['clientTop', 0]]) {
    Object.defineProperty(ta, name, { value: size, configurable: true });
  }
  let scrollTop = 0;
  Object.defineProperty(ta, 'scrollTop', { get: () => scrollTop, set: (v) => { scrollTop = v; }, configurable: true });
  Object.defineProperty(ta, 'scrollHeight', { value: 400, configurable: true });
  window.HTMLSpanElement.prototype.getClientRects = function () {
    return (layout.get(this.textContent) || []).map(r => ({ ...r, height: r.bottom - r.top }));
  };
  return ta;
}

test('only the tile whose reference is under the pointer gets the accent border', () => {
  const img = image(9);
  const pdf = file('spec.pdf', 45);
  const ta = laidOut(`Intro ${img}\n${pdf}`, new Map([
    [img, [{ left: 40, top: 0, right: 290, bottom: 18 }, { left: 0, top: 19, right: 60, bottom: 37 }]],
    [pdf, [{ left: 0, top: 38, right: 200, bottom: 56 }]],
  ]));
  const strip = renderAttachmentStrip(ta);
  const lit = () => tiles(strip).filter(t => t.classList.contains('attachment-tile--hover')).map(t => t.dataset.key);
  assert.equal(syncStripHover(ta, { clientX: 10 + 100, clientY: 20 + 8 }), '/api/images/2/9');
  assert.deepEqual(lit(), ['/api/images/2/9']);
  assert.equal(syncStripHover(ta, { clientX: 10 + 30, clientY: 20 + 25 }), '/api/images/2/9', 'its second line');
  assert.equal(syncStripHover(ta, { clientX: 10 + 50, clientY: 20 + 45 }), '/api/files/2/45');
  assert.deepEqual(lit(), ['/api/files/2/45'], 'only the hovered one');
  assert.equal(syncStripHover(ta, { clientX: 10 + 250, clientY: 20 + 45 }), null, 'past the end of its line');
  assert.deepEqual(lit(), []);
  assert.equal(syncStripHover(ta, { clientX: 10 + 20, clientY: 20 + 8 }), null, 'over plain text');
  assert.equal(syncStripHover(ta, { clientX: 5, clientY: 20 + 8 }), null, 'outside the field');
  // Scrolled by 20px, the point that was on the image's first line is on its second.
  ta.scrollTop = 20;
  assert.equal(syncStripHover(ta, { clientX: 10 + 30, clientY: 20 + 8 }), '/api/images/2/9');
  assert.equal(syncStripHover(ta, { clientX: 10 + 50, clientY: 20 + 25 }), '/api/files/2/45');
  assert.equal(syncStripHover(ta, null), null, 'the pointer left');
  assert.deepEqual(lit(), []);
  assert.equal(syncStripHover(document.createElement('textarea'), { clientX: 0, clientY: 0 }), null, 'no strip, no hover');
});

test('the field\'s own pointer events drive the hover; an edit under a still pointer re-reads it', () => {
  const pdf = file('spec.pdf', 45);
  const ta = laidOut(`${pdf} tail`, new Map([[pdf, [{ left: 0, top: 0, right: 150, bottom: 18 }]]]));
  const strip = renderAttachmentStrip(ta);
  ta.dispatchEvent(new MouseEvent('mousemove', { clientX: 10 + 20, clientY: 20 + 9 }));
  assert.equal(syncStripHover(ta), '/api/files/2/45', 'the last pointer position, checked again');
  assert.ok(tiles(strip)[0].classList.contains('attachment-tile--hover'));
  // Typing in front of the reference moves it from under the pointer.
  const moved = new Map([[pdf, [{ left: 160, top: 0, right: 290, bottom: 18 }]]]);
  window.HTMLSpanElement.prototype.getClientRects = function () {
    return (moved.get(this.textContent) || []).map(r => ({ ...r, height: r.bottom - r.top }));
  };
  ta.value = `More words ${pdf} tail`;
  assert.equal(syncStripHover(ta), null);
  assert.equal(tiles(strip)[0].classList.contains('attachment-tile--hover'), false);
  ta.dispatchEvent(new MouseEvent('mousemove', { clientX: 10 + 200, clientY: 20 + 9 }));
  assert.equal(syncStripHover(ta), '/api/files/2/45');
  ta.dispatchEvent(new MouseEvent('mouseleave'));
  assert.equal(tiles(strip)[0].classList.contains('attachment-tile--hover'), false, 'leaving clears it at once');
});
