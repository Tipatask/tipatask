'use strict';

// Shared by terminal and chat providers. Order is images-first:
// the image pass rewrites `![alt](url)` before the file pass's link regex ever runs, which
// keeps the two passes independent of each other's output regardless of the file regex's
// negative lookbehind.
const { localizeImageRefs } = require('./image-attach');
const { localizeFileRefs } = require('./file-attach');
const { localizeArtifactRefs } = require('./artifact-attach');

async function localizeAttachments({ taskId, prompt, taskCommentsBlock, projectRoot, description, backend }) {
  const afterImages = await localizeImageRefs({ taskId, prompt, taskCommentsBlock, projectRoot });
  const afterFiles = await localizeFileRefs({
    taskId,
    prompt: afterImages.prompt,
    taskCommentsBlock: afterImages.taskCommentsBlock,
    projectRoot,
  });
  return localizeArtifactRefs({ ...afterFiles, taskId, projectRoot, description, backend });
}

module.exports = { localizeAttachments, localizeImageRefs, localizeFileRefs };
