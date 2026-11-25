// A renderer receives the preview and returns a DOM node. The tab's signal owns any media URLs.
import { t } from './i18n.js';
import { renderMarkdown } from './utils.js';

const renderers = new Map();

export function registerPreviewRenderer(kind, render) {
  if (typeof render !== 'function') throw new TypeError('Expected a preview renderer');
  renderers.set(kind, render);
}

function message(key) {
  const el = document.createElement('p');
  el.setAttribute('role', 'status');
  el.dataset.viewerMessage = 'taskChat.viewer.' + key;
  el.textContent = t(el.dataset.viewerMessage);
  return el;
}

function numberedText({ content }) {
  // Two text nodes keep even a newline-heavy 1 MiB file from creating a DOM row per line.
  const pre = document.createElement('pre');
  pre.className = 'file-preview-source';
  const text = String(content).replace(/\r\n?/g, '\n');
  const count = 1 + (text.match(/\n/g)?.length || 0);
  const gutter = document.createElement('span');
  gutter.className = 'file-preview-gutter';
  gutter.setAttribute('aria-hidden', 'true');
  gutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  const code = document.createElement('code');
  code.textContent = text;
  pre.append(gutter, code);
  return pre;
}

registerPreviewRenderer('text', numberedText);
registerPreviewRenderer('markdown', preview => {
  if (preview.line) return numberedText(preview);
  const article = document.createElement('article');
  article.className = 'task-chat-md';
  article.innerHTML = renderMarkdown(preview.content, { cache: false });
  return article;
});

function mediaPreview(preview, pdf) {
  const el = document.createElement(pdf ? 'iframe' : 'img');
  el.className = pdf ? 'file-preview-pdf' : 'file-preview-image';
  if (pdf) el.title = preview.path;
  else el.alt = preview.path;
  const mime = pdf ? 'application/pdf' : preview.mime;
  if (!pdf && !/^image\/[\w.+-]+$/i.test(mime)) return message('unsupported');
  if (!pdf && !preview.blob) {
    el.src = 'data:' + mime + ';base64,' + preview.content;
    return el;
  }
  let blob = preview.blob;
  if (blob) blob = blob.slice(0, blob.size, mime);
  else {
    const binary = atob(preview.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
    blob = new Blob([bytes], { type: mime });
  }
  const url = URL.createObjectURL(blob);
  const release = () => URL.revokeObjectURL(url);
  if (preview.signal) preview.signal.addEventListener('abort', release, { once: true });
  else el.addEventListener('load', release, { once: true });
  el.src = url;
  return el;
}

registerPreviewRenderer('image', preview => mediaPreview(preview, false));
registerPreviewRenderer('pdf', preview => mediaPreview(preview, true));

export function renderPreview(preview) {
  if (preview.message) return message(preview.message);
  const renderer = renderers.get(preview.kind);
  if (!renderer) return message('unsupported');
  const body = renderer(preview);
  if (!preview.truncated) return body;
  const wrapper = document.createElement('div');
  wrapper.append(message('truncated'), body);
  return wrapper;
}
