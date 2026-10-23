'use strict';

// Shared by the renderer and server. No credentials or Node-only dependencies.
const IMAGE_ASPECT_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4']);
const IMAGE_DEFAULTS = Object.freeze({ aspectRatio: '1:1', count: 1, outputFolder: 'generated-images/' });
const isImageModel = row => row?.purpose === 'image';

function imageSettingsIssue(row) {
  if (!isImageModel(row)) return '';
  if (row.provider && row.provider !== 'openrouter') return 'imageProvider';
  const settings = row.imageDefaults || {};
  if (settings.aspectRatio !== undefined && !IMAGE_ASPECT_RATIOS.includes(settings.aspectRatio)) return 'imageAspectRatio';
  if (settings.count !== undefined && (!Number.isInteger(settings.count) || settings.count < 1 || settings.count > 10)) return 'imageCount';
  const folder = settings.outputFolder ?? IMAGE_DEFAULTS.outputFolder;
  if (typeof folder !== 'string' || !folder.trim() || /^[\\/]|^[a-z]:/i.test(folder)
    || /[\x00-\x1f<>:"|?*]/.test(folder) || folder.replace(/\\/g, '/').split('/').some(p => ['..', '.git', '.tipatask'].includes(p.toLowerCase()))) return 'imageFolder';
  return '';
}

function normalizeImageDefaults(row) {
  const issue = imageSettingsIssue(row);
  if (issue) throw Object.assign(new Error(issue), { code: 'IMAGE_SETTINGS', issue });
  const settings = row?.imageDefaults || {};
  return { aspectRatio: settings.aspectRatio ?? IMAGE_DEFAULTS.aspectRatio, count: settings.count ?? IMAGE_DEFAULTS.count,
    outputFolder: String(settings.outputFolder ?? IMAGE_DEFAULTS.outputFolder).trim().replace(/\\/g, '/') };
}

// Config ids carry Tipatask's provider prefix; OpenRouter's wire id does not.
function openRouterImageId(model) {
  return String(model || '').trim().replace(/^openrouter\//i, '');
}

module.exports = { IMAGE_ASPECT_RATIOS, IMAGE_DEFAULTS, isImageModel, imageSettingsIssue, normalizeImageDefaults, openRouterImageId };
