import { t } from './i18n.js';

export function renderImageTask(container, result, requestRetry) {
  if (!result) return;
  let panel = container.querySelector('.image-task-results');
  if (!panel) {
    panel = document.createElement('section');
    panel.className = 'image-task-results';
    panel.setAttribute('aria-live', 'polite');
    container.querySelector('.terminal-header').after(panel);
  }
  panel.replaceChildren();
  const status = document.createElement('p');
  status.textContent = t(result.error ? `imageTask.error.${result.error}` : `imageTask.${result.stage}`);
  panel.append(status);
  const files = document.createElement('div');
  files.className = 'image-task-files';
  for (const file of result.files || []) {
    const item = document.createElement('figure');
    const image = document.createElement('img');
    image.alt = t('agentSelect.purposeImage');
    if (typeof file.url === 'string' && file.url.startsWith('/api/image-task/result?')) image.src = file.url;
    const caption = document.createElement('figcaption');
    caption.textContent = file.path || file.relativePath;
    item.append(image, caption);
    if (image.getAttribute('src')) {
      const link = document.createElement('a');
      link.href = image.getAttribute('src');
      link.download = (file.path || file.relativePath || '').split(/[\\/]/).pop();
      link.textContent = t('imageTask.open');
      item.append(link);
    }
    files.append(item);
  }
  panel.append(files);
  if (result.canRetry) {
    for (const mode of result.canResume ? ['resume', 'generate'] : ['generate']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'image-task-action';
      button.textContent = t(mode === 'resume' ? 'imageTask.resume' : 'imageTask.retry');
      button.addEventListener('click', () => {
        for (const control of panel.querySelectorAll('button')) control.disabled = true;
        requestRetry({ type: 'image-task-retry', mode, runId: result.runId });
      });
      panel.append(button);
    }
  }
}
