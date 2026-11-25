'use strict';

// Keep these declarations in sync with api/src/lib/file-validation.js and
// api/src/lib/task-image-types.js. The Task App is shipped as a separate repo.
const TEXT_MIME_EXT = {
  'text/markdown': ['.md', '.markdown'],
  'text/csv': ['.csv'],
  'text/tab-separated-values': ['.tsv'],
  'application/json': ['.json'],
  'application/xml': ['.xml'],
  'text/xml': ['.xml'],
  'application/yaml': ['.yaml', '.yml'],
  'text/yaml': ['.yaml', '.yml'],
  'application/rtf': ['.rtf'],
  'text/rtf': ['.rtf'],
  'text/javascript': ['.js', '.mjs', '.cjs', '.jsx'],
  'text/typescript': ['.ts', '.mts', '.cts', '.tsx'],
  'text/x-python': ['.py', '.pyw'],
  'text/x-php': ['.php'],
  'text/x-go': ['.go'],
  'text/x-rust': ['.rs'],
  'text/x-java-source': ['.java'],
  'text/x-c': ['.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'],
  'text/x-c++src': ['.cc', '.cpp', '.cxx'],
  'text/x-c++hdr': ['.hh', '.hpp', '.hxx', '.h'],
  'text/x-shellscript': ['.sh', '.bash', '.zsh'],
  'application/sql': ['.sql'],
  'text/css': ['.css'],
  'text/html': ['.html', '.htm'],
  'text/x-log': ['.log'],
  'text/x-diff': ['.diff', '.patch'],
  'text/x-ini': ['.ini', '.conf', '.cfg'],
  'application/toml': ['.toml'],
};

const FILE_MIME_EXT = {
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-powerpoint': ['.ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'application/vnd.oasis.opendocument.text': ['.odt'],
  'application/vnd.oasis.opendocument.spreadsheet': ['.ods'],
  'text/plain': ['.txt', ...Object.values(TEXT_MIME_EXT).flat()],
  ...TEXT_MIME_EXT,
};

const MIME_ALIASES = {
  'application/javascript': 'text/javascript',
  'application/x-javascript': 'text/javascript',
  'application/typescript': 'text/typescript',
  'text/x-typescript': 'text/typescript',
  'text/x-script.python': 'text/x-python',
  'application/x-php': 'text/x-php',
  'application/x-httpd-php': 'text/x-php',
  'text/x-php-script': 'text/x-php',
  'text/x-rustsrc': 'text/x-rust',
  'text/x-java': 'text/x-java-source',
  'application/x-sh': 'text/x-shellscript',
  'application/x-shellscript': 'text/x-shellscript',
  'text/x-sh': 'text/x-shellscript',
  'text/sql': 'application/sql',
  'application/x-sql': 'application/sql',
  'text/diff': 'text/x-diff',
  'text/toml': 'application/toml',
};

const IMAGE_MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
};

function fileMimeExtensions(mimeType) {
  const declared = mimeType.toLowerCase();
  const mime = Object.hasOwn(MIME_ALIASES, declared) ? MIME_ALIASES[declared] : declared;
  return Object.hasOwn(FILE_MIME_EXT, mime) ? FILE_MIME_EXT[mime] : null;
}

function imageMimeExtension(mimeType) {
  return Object.hasOwn(IMAGE_MIME_EXT, mimeType) ? IMAGE_MIME_EXT[mimeType] : null;
}

function rejectUpload(message, code) {
  throw Object.assign(new Error(message), { statusCode: 400, code });
}

function validateAttachmentUpload(payload, lookupMime) {
  const { filename, mimeType, data } = payload || {};
  if (typeof filename !== 'string' || !filename.trim()) rejectUpload('filename required', 'INVALID_DATA');
  if (typeof mimeType !== 'string' || !mimeType.trim()) rejectUpload('mimeType required', 'INVALID_MIME');
  if (typeof data !== 'string' || !data.trim()) rejectUpload('data required', 'INVALID_DATA');
  if (!lookupMime(mimeType)) rejectUpload('Unsupported mimeType', 'INVALID_MIME');
}

module.exports = { fileMimeExtensions, imageMimeExtension, validateAttachmentUpload };
