'use strict';

// Size accounting for the text a Claude objective turn writes to the CLI's stdin. Pure:
// no fs, no session access — claude-session.js feeds it the exact stdin string right before
// proc.stdin.write() and logs / dumps what comes back. Everything here exists so a request the
// API rejects as too large retains its stdin evidence even without a result event.
// CLI-added instructions, schemas and file expansion require separate replay measurements.

const SEPARATOR = '---- stdin (exact) ----\n';

// `@path` mentions the Claude CLI expands into file contents before the request is sent —
// one possible source of growth beyond the stdin size. Counts tokens at line start or after
// whitespace / an opening paren, never e-mail-style `name@host`.
function countMentions(text) {
  const m = String(text || '').match(/(?:^|[\s(])@[\w./~-]+/g);
  return m ? m.length : 0;
}

// Markdown image embeds plus links into this project's image / file attachment stores.
function countAttachmentRefs(text) {
  const s = String(text || '');
  const images = s.match(/!\[[^\]]*\]\([^)]+\)/g);
  const files = s.match(/(?<!!)\[[^\]]*\]\((?:https?:)?[^)]*\/(?:images|files)\/[^)]+\)/g);
  return (images ? images.length : 0) + (files ? files.length : 0);
}

const SECTION_MARKER = /^(#{1,3} .+|<[a-z][a-z-]*>)\s*$/;

// Split the stdin text at its own structural markers — `### <prefetch block>` headings and
// `<objective>`-style block openers — and measure each piece. The leading unmarked text is
// reported as `(preamble)`. Offsets are JS string indices; bytes are UTF-8.
function describePromptSections(text) {
  const s = String(text || '');
  const sections = [];
  let name = '(preamble)';
  let start = 0;
  let offset = 0;
  for (const line of s.split('\n')) {
    const m = line.match(SECTION_MARKER);
    if (m && offset > 0) {
      sections.push({ name, chars: offset - start, bytes: Buffer.byteLength(s.slice(start, offset), 'utf8'), startOffset: start });
      name = m[1].trim();
      start = offset;
    } else if (m && offset === 0) {
      name = m[1].trim();
    }
    offset += line.length + 1;
  }
  sections.push({ name, chars: s.length - start, bytes: Buffer.byteLength(s.slice(start), 'utf8'), startOffset: start });
  return sections.filter(sec => sec.chars > 0 || sections.length === 1);
}

function measureStdin(stdin) {
  const text = String(stdin || '');
  return {
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    mentions: countMentions(text),
    attachmentRefs: countAttachmentRefs(text),
    sections: describePromptSections(text),
  };
}

// One-line log record, emitted before the stdin write — so it exists for turns that never
// produce a `result` event (the [objective:profile] line only appears after one).
function formatPromptSizeLine({ taskId, turnIdx, mode, systemPromptChars, stdin, metrics }) {
  const m = metrics || measureStdin(stdin);
  const sections = m.sections.map(sec => `${sec.name.replace(/\s+/g, '_')}:${sec.chars}`).join(',');
  return `[objective:prompt-size] task=${taskId} turn=${turnIdx} mode=${mode}` +
    ` systemPrompt.chars=${systemPromptChars} stdin.chars=${m.chars} stdin.bytes=${m.bytes}` +
    ` mentions=${m.mentions} attachmentRefs=${m.attachmentRefs} sections=${sections || '(none)'}`;
}

// The objective-prompt.md file: a markdown header with every number and a per-section table,
// then SEPARATOR, then the exact stdin text. `body starts at byte N` is the header's own UTF-8
// length, so `file bytes − N === stdin.bytes` can be checked with wc -c alone.
function buildPromptDump({ taskId, turnIdx, mode, systemPromptChars, stdin, metrics, profile }) {
  const text = String(stdin || '');
  const m = metrics || measureStdin(text);
  const p = profile || {};
  const lines = [
    '# objective-prompt',
    '',
    `- task: ${taskId}`,
    `- turn: ${turnIdx}`,
    `- mode: ${mode}`,
    `- written: ${new Date().toISOString()}`,
    `- systemPrompt.chars: ${systemPromptChars}`,
    `- stdin.chars: ${m.chars}`,
    `- stdin.bytes: ${m.bytes}`,
    `- mentions(@path): ${m.mentions}`,
    `- attachmentRefs: ${m.attachmentRefs}`,
    `- profile.staticBundle.chars: ${p.staticChars ?? 'n/a'}`,
    `- profile.cachedTags: count=${p.cachedTagsCount ?? 'n/a'} chars=${p.cachedTagsChars ?? 'n/a'}`,
    `- profile.serverHistory: messages=${p.serverHistMessages ?? 'n/a'} chars=${p.serverHistChars ?? 'n/a'}`,
    `- profile.compress: summaries=${p.compressedSummariesCount ?? 'n/a'} through=${p.compressedThrough ?? 'n/a'}`,
    '',
    '| section | chars | bytes | startOffset |',
    '|---|---|---|---|',
    ...m.sections.map(sec => `| ${sec.name.replace(/\|/g, '\\|')} | ${sec.chars} | ${sec.bytes} | ${sec.startOffset} |`),
    '',
  ];
  // Two passes: the header states its own byte length, and the number's width can change it.
  let header = '';
  let bodyStart = 0;
  for (let i = 0; i < 3; i++) {
    header = [...lines, `body starts at byte ${bodyStart}`, '', SEPARATOR].join('\n');
    const len = Buffer.byteLength(header, 'utf8');
    if (len === bodyStart) break;
    bodyStart = len;
  }
  return { header, body: text, bodyStart };
}

module.exports = {
  SEPARATOR,
  countMentions,
  countAttachmentRefs,
  describePromptSections,
  measureStdin,
  formatPromptSizeLine,
  buildPromptDump,
};
