'use strict';

// Hand-synced twin: api/src/lib/arch-budget.js. Neither deployed
// package can import across the repository boundary; keep this pure body identical.
const ARCH_REPLY_CHAR_BUDGET = 60000;
const OUTLINE_HINT = 'Fetch a heading with section in get_tag_architecture or get_tag_architectures, or Read ai/architecture/<tag_name>.md locally. Outline may omit or clip headings.';

// Only ##/### headings are addressable. All ATX heading levels delimit their
// parents; headings in backtick/tilde fences are code, including longer fences.
function architectureSections(content) {
  const sections = [];
  const stack = [];
  let fence = null;
  for (const line of content.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const text = line[0].replace(/\r?\n$/, '');
    const marker = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      continue;
    }
    const match = text.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/);
    if (!match) continue;
    const level = match[1].length;
    while (stack.length && stack.at(-1).level >= level) stack.pop().end = line.index;
    if (level !== 2 && level !== 3) continue;
    const heading = match[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
    const entry = { heading, level, start: line.index + line[0].length, end: content.length };
    sections.push(entry);
    stack.push(entry);
  }
  return sections.map(({ heading, start, end }) => ({ heading, body: content.slice(start, end) }));
}

function textReply(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

// entries are [tag, content|null] pairs in request order. Small single-tag replies
// remain raw Markdown; batches remain pretty JSON maps. Count the entire serialized
// MCP result, including the second escaping layer around a batch's JSON text.
function buildArchitectureReply(entries, { single = false, section, budget = ARCH_REPLY_CHAR_BUDGET } = {}) {
  if (!Number.isInteger(budget) || budget < 1000) throw new RangeError('Architecture reply budget must be an integer >= 1000');
  const docs = new Map(entries);
  for (const [tag, content] of docs) {
    if (content == null) docs.set(tag, null);
    else if (section !== undefined) {
      const found = architectureSections(content).find(s => s.heading.toLowerCase() === section.trim().toLowerCase());
      docs.set(tag, found ? found.body : null);
    }
  }
  if (single && docs.values().next().value == null) {
    const tag = String(docs.keys().next().value).slice(0, 200);
    return textReply(section === undefined
      ? `No architecture file found for tag "${tag}". File expected at: ai/architecture/${tag}.md`
      : `No section "${section.slice(0, 200)}" found for tag "${tag}". Fetch the document outline or Read ai/architecture/${tag}.md locally.`, true);
  }
  function reply(values) {
    const value = single ? values.values().next().value : Object.fromEntries(values);
    return textReply(single && typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  const size = values => JSON.stringify(reply(values)).length;
  if (size(docs) <= budget) return reply(docs);

  // Reserve a minimal outline for every document before greedily admitting whole
  // docs. Otherwise a full first doc could leave no space for later outlines.
  const values = new Map([...docs].map(([tag, content]) => [tag, content == null ? null : {
    truncated: true, chars: content.length, sections: [], hint: OUTLINE_HINT,
  }]));
  if (size(values) > budget) return textReply('Architecture reply metadata exceeds the budget. Request fewer or shorter tag names.', true);
  for (const [tag, content] of docs) {
    if (content == null) continue;
    const outline = values.get(tag);
    values.set(tag, content);
    if (size(values) > budget) values.set(tag, outline);
  }

  // Share spare space among outlines so one doc's growing heading list cannot
  // crowd out every other doc. Keep exact heading text whenever it fits.
  const outlined = [...values].filter(([, value]) => value && typeof value === 'object');
  for (let i = 0; i < outlined.length; i++) {
    const [tag, outline] = outlined[i];
    const ceiling = size(values) + Math.floor((budget - size(values)) / (outlined.length - i));
    for (const { heading, body } of architectureSections(docs.get(tag))) {
      const entry = { heading, chars: body.length };
      outline.sections.push(entry);
      if (size(values) <= ceiling) continue;
      // A pathological heading can itself exceed the reply limit. A clipped
      // heading is only a preview; the hint directs callers to the local file.
      entry.heading = heading.slice(0, 200) + (heading.length > 200 ? '…' : '');
      if (size(values) <= ceiling) continue;
      outline.sections.pop();
      break;
    }
  }
  return reply(values);
}

module.exports = { ARCH_REPLY_CHAR_BUDGET, architectureSections, buildArchitectureReply };
