// Plain-text URL links for the xterm terminals (task terminals and the objective console).
//
// xterm.js links OSC 8 hyperlinks itself, through the Terminal's `linkHandler` option, but
// leaves a URL printed as plain text inert. registerPlainUrlLinks() adds a link provider that
// finds http(s) URLs in the rendered buffer and activates them through that same handler, so
// both forms share one confirmation dialog, one scheme check and one platform opener. xterm
// asks its OSC 8 provider first and drops plain matches that overlap an OSC 8 link, so a
// hyperlinked URL never produces two links.
//
// A logical line is a row plus the rows the terminal soft-wrapped it onto (`isWrapped`), and
// URLs are matched across the whole of it: a URL longer than the terminal width opens intact
// from either row. A row the program ended itself (a TUI wrapping its own output) is a real
// line break. A match that fills such a row to its last column while the next row carries on
// with URL characters may continue there, and that continuation cannot be told apart from
// unrelated text, so the match is left unlinked instead of opening a truncated URL. The same
// applies to a URL the program cut short with an ellipsis.
//
// No imports: node-testable against a real xterm buffer or a stub with the same shape.

// Characters that end a URL: whitespace, ASCII and C1 controls, quotes, angle brackets, the
// characters RFC 3986 never allows unescaped, the ellipsis a program prints for cut text and
// the box-drawing/block glyphs TUIs draw borders with.
const URL_PATTERN = /https?:\/\/[^\s"'<>`\\^{|}\u0000-\u001f\u007f-\u009f…─-▟]+/gi;
const URL_CHAR = /[^\s"'<>`\\^{|}\u0000-\u001f\u007f-\u009f…─-▟]/;
const TRAILING_PUNCTUATION = '.,;:!?';
const CLOSING_BRACKETS = { ')': '(', ']': '[' };
// Soft-wrapped rows read above and below the hovered row. A match reaching a window edge that
// cuts its logical line is dropped, so a URL is either linked whole or not at all.
const MAX_WRAP_ROWS = 64;
const ELLIPSIS = '…';

function count(text, char) {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}

// Sentence punctuation after a URL, and a closing bracket the URL never opened, belong to the
// surrounding text: "(see https://example.com/a)." links https://example.com/a.
export function trimUrlMatch(text) {
  let url = text;
  for (;;) {
    const last = url[url.length - 1];
    if (TRAILING_PUNCTUATION.includes(last)) {
      url = url.slice(0, -1);
    } else if (CLOSING_BRACKETS[last] && count(url, last) > count(url, CLOSING_BRACKETS[last])) {
      url = url.slice(0, -1);
    } else {
      return url;
    }
  }
}

function isOpenableUrl(url) {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname;
  } catch {
    return false;
  }
}

// Every openable http(s) URL in `text`, as { start, end, matchEnd, url }: `end` is exclusive,
// `matchEnd` is where the URL characters ran out before trailing punctuation was trimmed. A URL
// the text cuts short with an ellipsis is skipped.
export function findPlainUrls(text) {
  const source = String(text);
  const found = [];
  for (const match of source.matchAll(URL_PATTERN)) {
    const url = trimUrlMatch(match[0]);
    const start = match.index;
    const matchEnd = start + match[0].length;
    if (source[matchEnd] === ELLIPSIS) continue;
    if (!isOpenableUrl(url)) continue;
    found.push({ start, end: start + url.length, matchEnd, url });
  }
  return found;
}

// The text of the logical line holding buffer row `row` (0-based), with the 1-based cell of
// each UTF-16 unit. Wide characters take two cells and empty cells read as spaces.
function readLogicalLine(buffer, row, cols) {
  let first = row;
  while (first > 0 && row - first < MAX_WRAP_ROWS && buffer.getLine(first)?.isWrapped) first--;
  let last = row;
  while (last - row < MAX_WRAP_ROWS && buffer.getLine(last + 1)?.isWrapped) last++;
  const cell = buffer.getNullCell();
  let text = '';
  const cells = [];
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    for (let x = 0; x < cols; x++) {
      const current = line.getCell(x, cell);
      if (!current) break;
      const width = current.getWidth();
      if (width === 0) continue; // second half of a wide character
      const chars = current.getChars() || ' ';
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: y + 1, width: Math.max(width, 1) });
      text += chars;
    }
  }
  return {
    text,
    cells,
    cutBefore: first > 0 && !!buffer.getLine(first)?.isWrapped,
    cutAfter: !!buffer.getLine(last + 1)?.isWrapped,
    lastRow: last,
  };
}

// The row after a logical line goes on with URL characters (after any indentation): a URL
// that filled the line to its last column may continue there.
function continuesOnNextRow(buffer, lastRow) {
  const next = buffer.getLine(lastRow + 1);
  if (!next) return false;
  const first = next.translateToString(true).trimStart()[0];
  return !!first && URL_CHAR.test(first);
}

// Links for 1-based buffer line `y`, in xterm's ILink shape.
export function plainUrlLinks(terminal, y, activate) {
  const buffer = terminal.buffer.active;
  const cols = terminal.cols;
  if (!buffer.getLine(y - 1)) return [];
  const { text, cells, cutBefore, cutAfter, lastRow } = readLogicalLine(buffer, y - 1, cols);
  const links = [];
  for (const { start, end, matchEnd, url } of findPlainUrls(text)) {
    if ((start === 0 && cutBefore) || (matchEnd === text.length && cutAfter)) continue;
    // URL characters up to the last column of the line's last row: possibly hard-wrapped.
    const reach = cells[matchEnd - 1];
    if (reach.y - 1 === lastRow && reach.x + reach.width - 1 >= cols && continuesOnNextRow(buffer, lastRow)) continue;
    const from = cells[start];
    const to = cells[end - 1];
    const endX = to.x + to.width - 1;
    if (y < from.y || y > to.y) continue;
    links.push({
      text: url,
      range: { start: { x: from.x, y: from.y }, end: { x: endX, y: to.y } },
      activate: (event, uri) => activate(event, uri),
    });
  }
  return links;
}

// Route plain-text URLs in `terminal` through `linkHandler.activate()`, the handler the
// Terminal also uses for OSC 8 hyperlinks. Returns xterm's disposable, or null for a terminal
// without link providers, which keeps its OSC 8 links and opens normally.
export function registerPlainUrlLinks(terminal, linkHandler) {
  if (typeof terminal?.registerLinkProvider !== 'function') return null;
  return terminal.registerLinkProvider({
    provideLinks(y, callback) {
      let links = [];
      try {
        links = plainUrlLinks(terminal, y, (event, uri) => linkHandler.activate(event, uri));
      } catch {
        links = [];
      }
      callback(links.length ? links : undefined);
    },
  });
}
