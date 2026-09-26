'use strict';

// C1247 — single entry point combining both attachment localizers so the 7 spawn call sites
// that used to call localizeImageRefs directly only need one call each. Order is images-first:
// the image pass rewrites `![alt](url)` before the file pass's link regex ever runs, which
// keeps the two passes independent of each other's output regardless of the file regex's
// negative lookbehind.
const { localizeImageRefs } = require('./image-attach');
const { localizeFileRefs } = require('./file-attach');

async function localizeAttachments({ taskId, prompt, taskCommentsBlock, projectRoot }) {
  const afterImages = await localizeImageRefs({ taskId, prompt, taskCommentsBlock, projectRoot });
  return localizeFileRefs({
    taskId,
    prompt: afterImages.prompt,
    taskCommentsBlock: afterImages.taskCommentsBlock,
    projectRoot,
  });
}

module.exports = { localizeAttachments, localizeImageRefs, localizeFileRefs };
