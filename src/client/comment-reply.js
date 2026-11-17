// TPT9336 — client twin of api/src/lib/comment-reply.js, the TPT9334 reply-citation comment
// format. A reply is ordinary comment content:
//
//   <!-- tipatask:reply:42 -->
//   > **Anton Matiienko:** first line of the quoted comment
//   > further quoted lines (an empty quoted line is a bare ">")
//
//   @Anton Matiienko the reply itself
//
// The Task App is a separate git repository and cannot require/import across the gitlink
// into api/ (the mention-highlight.js and src/server/transliteration.js twins exist for the
// same reason), so this file is a hand-synced copy. Everything from the REPLY_QUOTE_MAX line
// down to the closing brace of buildReplyCitation() is byte-identical to the API's file; only
// this header and the ESM export line at the bottom differ. comment-reply.test.js runs the
// API's own cases against this copy (always) and fails when the shared code drifts from the
// API's (skipped when api/ is not checked out next to this repo). Pure, no imports.

const REPLY_QUOTE_MAX = 600;

const REPLY_MARKER_RE = /^<!--\s*tipatask:reply:(\d+)\s*-->$/;
// One blockquote line: up to three spaces of indentation, ">", one optional space. The s flag
// keeps a U+2028/U+2029 inside a quoted line from ending the match.
const QUOTE_LINE_RE = /^ {0,3}> ?(.*)$/s;
// The label opening the first quoted line: "**Name:**", then that line's quoted text.
const AUTHOR_LABEL_RE = /^\*\*(.+?):\*\*[ \t]*(.*)$/s;

function splitLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n');
}

// Drops whitespace-only lines from both ends of a line list.
function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

// Counts code points, not UTF-16 units, so the cut never splits a surrogate pair (a lone
// surrogate is not valid UTF-8 and would fail the comment's INSERT).
function capQuote(text) {
  const chars = Array.from(text);
  if (chars.length <= REPLY_QUOTE_MAX) return text;
  return `${chars.slice(0, REPLY_QUOTE_MAX).join('').trimEnd()}…`;
}

// { commentId, author, quote, body } when `content` is a reply, else null. commentId is the
// replied-to comment's id (a number), author the label's name or null, quote the quoted text
// without its "> " prefixes and label, body the reply after the quote. Reads what an edit can
// leave behind: CRLF line endings, a hand-edited quote or body, blank lines added after the
// marker, a missing blank line between quote and body. Not a reply: no marker on the first
// non-blank line, or no blockquote following the marker.
function parseReplyCitation(content) {
  if (typeof content !== 'string') return null;
  const lines = splitLines(content);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const marker = i < lines.length ? REPLY_MARKER_RE.exec(lines[i].trim()) : null;
  if (!marker) return null;
  const commentId = Number(marker[1]);
  if (!Number.isSafeInteger(commentId) || commentId < 1) return null;

  i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  const quoted = [];
  for (; i < lines.length; i++) {
    const line = QUOTE_LINE_RE.exec(lines[i]);
    if (!line) break;
    quoted.push(line[1]);
  }
  if (quoted.length === 0) return null;

  let author = null;
  const label = AUTHOR_LABEL_RE.exec(quoted[0]);
  if (label && label[1].trim()) {
    author = label[1].trim();
    quoted[0] = label[2];
  }

  return {
    commentId,
    author,
    quote: trimBlankLines(quoted).join('\n').trimEnd(),
    body: trimBlankLines(lines.slice(i)).join('\n').trimEnd(),
  };
}

// The reply's own text: the body when `content` is a reply, else `content` unchanged.
function stripReplyCitation(content) {
  const reply = parseReplyCitation(content);
  if (reply) return reply.body;
  return typeof content === 'string' ? content : '';
}

// The composer text that starts a reply to one comment: marker, quote, blank line, then
// "@<author> " (nothing after the blank line when the comment has no author). `author` is the
// name the client shows for that comment, or null. `text` is the replied-to comment's content;
// quoting a reply takes only its body, so citations never nest.
function buildReplyCitation({ commentId, author, text } = {}) {
  const id = Number(commentId);
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('commentId must be a positive integer');
  const name = typeof author === 'string' ? author.replace(/[\r\n\u2028\u2029]+/g, ' ').trim() : '';
  const original = stripReplyCitation(String(text ?? '').replace(/\r\n?/g, '\n')).trim();
  const lines = capQuote(original).split('\n');
  // Without a label, a first quoted line that looks like one ("**Note:** …") would read back
  // as the author; an empty first quoted line keeps it part of the quote.
  if (!name && AUTHOR_LABEL_RE.test(lines[0])) lines.unshift('');
  const quote = lines.map((line, idx) => {
    const quotedLine = idx === 0 && name ? `**${name}:**${line ? ` ${line}` : ''}` : line;
    return quotedLine ? `> ${quotedLine}` : '>';
  });
  return `<!-- tipatask:reply:${id} -->\n${quote.join('\n')}\n\n${name ? `@${name} ` : ''}`;
}

export { REPLY_QUOTE_MAX, parseReplyCitation, stripReplyCitation, buildReplyCitation };
