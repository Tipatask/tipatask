import createDOMPurify from 'dompurify';

// Markdown is rendered into task cards, comments, and chat bubbles with innerHTML.
// Keep this policy narrower than DOMPurify's defaults: SVG, MathML, forms, inline
// styles, event handlers, and executable URL schemes have no place in those views.
const ALLOWED_TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'img', 'input', 'li', 'mark', 'ol', 'p', 'pre', 'span', 'strong', 'table',
  'tbody', 'td', 'th', 'thead', 'tr', 'ul',
];
const ALLOWED_ATTR = [
  'align', 'alt', 'checked', 'class', 'disabled', 'href', 'src', 'start', 'title', 'type',
];
const PURIFIERS = new WeakMap();

function permittedUrl(value, attribute, win) {
  // Reject controls before URL parsing: the browser strips some of them from a
  // scheme (e.g. java\nscript:) and entity decoding happens before this hook.
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new win.URL(value, win.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:'
      || (attribute === 'href' && url.protocol === 'mailto:');
  } catch {
    return false;
  }
}

function permittedClasses(tag, value) {
  const classes = String(value).split(/\s+/).filter(Boolean);
  if (tag === 'CODE') return classes.filter(c => /^language-[\w-]+$/.test(c)).join(' ');
  const names = {
    A: ['file-attachment-link'],
    DIV: ['trello-appendix'],
    MARK: ['mention', 'mention--agent'],
    SPAN: ['file-ref'],
  }[tag] || [];
  return classes.filter(c => names.includes(c)).join(' ');
}

function getPurifier(win) {
  if (!win?.document || !win.URL) throw new Error('Markdown sanitizer requires a browser DOM');
  let purifier = PURIFIERS.get(win);
  if (purifier) return purifier;

  purifier = createDOMPurify(win);
  purifier.addHook('uponSanitizeAttribute', (node, data) => {
    const tag = node.nodeName.toUpperCase();
    const name = data.attrName.toLowerCase();
    if (name === 'href' || name === 'src') {
      data.keepAttr = (name === 'href' && tag === 'A' || name === 'src' && tag === 'IMG')
        && permittedUrl(data.attrValue, name, win);
    } else if (name === 'class') {
      data.attrValue = permittedClasses(tag, data.attrValue);
      data.keepAttr = Boolean(data.attrValue);
    } else if (name === 'title') {
      data.keepAttr = tag === 'A' || tag === 'IMG';
    } else if (name === 'alt') {
      data.keepAttr = tag === 'IMG';
    } else if (name === 'align') {
      data.keepAttr = (tag === 'TH' || tag === 'TD') && /^(left|center|right)$/.test(data.attrValue);
    } else if (name === 'start') {
      data.keepAttr = tag === 'OL' && /^-?\d+$/.test(data.attrValue);
    } else if (name === 'type' || name === 'checked' || name === 'disabled') {
      data.keepAttr = tag === 'INPUT' && (name !== 'type' || data.attrValue === 'checkbox');
    }
  });
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName.toUpperCase() === 'INPUT') {
      // GFM task-list checkboxes are display-only. Never leave a live form field.
      node.setAttribute('type', 'checkbox');
      node.setAttribute('disabled', '');
    }
  });
  PURIFIERS.set(win, purifier);
  return purifier;
}

export function sanitizeMarkdownHtml(html) {
  return getPurifier(globalThis.window).sanitize(String(html || ''), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}
