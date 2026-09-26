import state from '../src/client/state.js';
import { renderCard, registerCardCallbacks, setupCardInteractions } from '../src/client/task-card.js';
import { openTaskEditModal, closeTaskEditModal, requestCloseTaskEditModal } from '../src/client/task-board.js';
import { openAgentsModal, closeAgentsModal } from '../src/client/agents-modal.js';
import { setLocale } from '../src/client/i18n.js';

const task = {
  id: 'TPT335', title: 'Keyboard task', description: 'Original description',
  status: 'pending', priority: 1, category: 'CODING', agentAssignee: 'human',
  assignee: null, tags: [], dependencies: [],
};

state.currentUserId = 1;
const app = document.getElementById('app');
app.innerHTML = renderCard(task);
registerCardCallbacks({
  onOpenTaskEditModal: (_taskId, trigger) => openTaskEditModal(task.id, {
    preloadedTask: structuredClone(task), trigger,
    readOnly: window.probe?.readOnly || false,
    onSavePreview: async (draft) => {
      window.probe.saved = structuredClone(draft);
      closeTaskEditModal(true);
    },
  }),
});
setupCardInteractions(app);

window.probe = {
  saved: null,
  readOnly: false,
  openReadOnly: () => openTaskEditModal(task.id, {
    preloadedTask: structuredClone(task),
    trigger: app.querySelector('.card-edit-btn'),
    readOnly: true,
  }),
  closeTaskEditModal,
  requestCloseTaskEditModal,
  openAgentsModal,
  closeAgentsModal,
  setLocale,
};
document.getElementById('settings-agents-edit').addEventListener('click', () => openAgentsModal());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void requestCloseTaskEditModal();
});
