// Frontend entry point — modules will be extracted here
import './styles.css';
import './notification-cards.css'; // (TPT484) compact notification page shared with the banner window
import * as constants from './constants.js';
import * as i18n from './i18n.js';
import * as statusRegistry from './status-registry.js';
import * as groupLabel from './group-label.js';
import state from './state.js';
import * as utils from './utils.js';
import * as wsClient from './ws-client.js';
import * as objectiveTabs from './objective-tabs.js';
import * as subtaskCount from './subtask-count.js'; // (C1463) template.html needs countChildProgress() for the objective-tab tick
import * as subtaskChain from './subtask-chain.js'; // (TPT59) template.html needs buildAncestorCrumbs() to rebuild the full breadcrumb chain
import * as taskCard from './task-card.js';
import * as taskBoard from './task-board.js';
import * as consoleModal from './console-modal.js';
import * as recipeSidebar from './recipe-sidebar.js';
import * as chatUI from './chat-ui.js';
import * as chatTaskPreview from './chat-task-preview.js';
import * as specChat from './spec-chat.js';
import * as taskChat from './task-chat.js';
import * as setupModal from './setup-modal.js';
import * as notifications from './notifications.js';
import * as attentionNotifications from './attention-notifications.js';
import * as completionNotifications from './completion-notifications.js';
import * as attentionWs from './attention-ws.js';
import * as attentionState from './attention-state.js';
import * as taskActivity from './task-activity.js';
import * as activityNotifications from './activity-notifications.js';
import * as notificationCenter from './notification-center.js';
import './desktop-notification-panel.js'; // (TPT480) Electron-only full desktop-notification list (banner "Show More")
import * as projectCreationWizard from './project-creation-wizard.js';
import { buildPresetSeedReport } from './preset-seed-report.js'; // (TPT203) wizard partial-seed report
import * as projectOpenFlow from './project-open-flow.js';
import * as audioRecorder from './audio-recorder.js';
import { initApiConnection } from './api-connection.js';
import * as perfLog from './perf-log.js';
import { ensureFileLinkHandler } from './file-attach.js';
import * as tagMatch from './tag-match.js';
import * as statusFilterSelect from './status-filter-select.js';
import * as agentQuota from './agent-quota.js'; // (TPT310) left-nav plan-usage block; template.html mounts it and resets it on project change
import * as mergeBranchesModal from './merge-branches-modal.js'; // (TPT345) Merge task branches panel; template.html reaches it via the Project menu

notifications.requestPermission();
// (TPT484) Shared alert registry: click/dismiss bridge plus main's surface decision for this window.
notifications.ensureNotificationBridge();
notificationCenter.installNotificationSurface();

// Expose modules globally so the inline <script> in template.html can access them.
window.TipTask = { constants, i18n, statusRegistry, groupLabel, state, utils, wsClient, objectiveTabs, subtaskCount, subtaskChain, taskCard, taskBoard, ...consoleModal, ...recipeSidebar, chatUI, chatTaskPreview, specChat, taskChat, setupModal, notifications, attentionNotifications, completionNotifications, attentionWs, attentionState, taskActivity, activityNotifications, notificationCenter, projectCreationWizard, projectOpenFlow, audioRecorder, perfLog, tagMatch, statusFilterSelect, agentQuota, mergeBranchesModal };
// Terminal task-title links need a page-level bridge: task-board.js owns the modal,
// while template.html owns loadAndRender() and can select Project Board first.
window.TipTask.openTaskEditModal = taskBoard.openTaskEditModalFromTerminal;
// (TPT466) The task workspace (edit / agent terminal / chat in one modal): console-modal.js
// openTerminal() and task-chat.js open() route here, and the terminal pane closes the
// workspace through requestCloseTaskEditModal(). Neither module imports the modal itself.
window.TipTask.openTaskWorkspace = taskBoard.openTaskWorkspace;
window.TipTask.requestCloseTaskEditModal = taskBoard.requestCloseTaskEditModal;

// (C1206) Bind the global voice-input shortcut here, at bundle evaluation — before any board
// render. chatUI.attachChatHandlers() also calls registerVoiceShortcut() every render cycle
// (idempotent, kept as belt-and-braces), but loadAndRender() has two early-return paths before it
// ever reaches that call (the C1200 recording-deferral guard, and a failed first board fetch
// falling into renderTaskLoadError()) — either one left the shortcut permanently unbound on a
// cold boot that hit them. registerVoiceShortcut() itself no-ops safely if called twice.
try { chatUI.registerVoiceShortcut(); } catch (err) { console.warn('[voice] registerVoiceShortcut() failed at boot', err); }

// (C1258) Same reasoning as registerVoiceShortcut() above, plus a second one: this used to
// only ever bind as a side effect of chatUI.attachChatHandlers(), which C1258 now gates behind
// isNewSectionTab() to cut the left-nav Tasks<->Create switch's wiring cost. But renderMarkdown()
// (utils.js) stamps class="file-attachment-link" onto file-attachment links inside BOARD task
// card descriptions too, not just chat messages — so this delegate must bind at boot,
// unconditional of which section ever renders first. Idempotent (file-attach.js), safe to leave
// the redundant call inside attachChatHandlers() as belt-and-braces.
try { ensureFileLinkHandler(); } catch (err) { console.warn('[files] ensureFileLinkHandler() failed at boot', err); }

// (C1502) Same boot-time-binding reasoning as registerVoiceShortcut()/ensureFileLinkHandler()
// above: loadAndRender() has early-return paths, so a listener bound only as a render side
// effect could end up permanently unbound. Idempotent — safe if ever called twice.
try { taskBoard.enableTypeToFilter(); } catch (err) { console.warn('[board] enableTypeToFilter() failed at boot', err); }

// (C1210) This DOM listener is the browser-tab fallback. In the packaged Electron app, root
// cause traced this session: the OS itself (not this app) swallows the shortcut combo before any
// application's document ever sees the keydown — see tt-audio-input.md § Keyboard Shortcut
// (C1210). No renderer-side listener can be rescued from that, so the combo is ALSO owned by the
// Electron app menu (main.js), which relays a press over IPC to this same trigger. `onVoiceShortcut`
// only exists on `window.electronAPI` inside Electron — undefined (silently skipped) in a plain
// browser tab, where the DOM listener above is the only route there is.
try {
  const unsubscribeVoiceShortcut = window.electronAPI?.onVoiceShortcut?.(() => chatUI.triggerVoiceShortcut('menu'));
  console.info(`[voice] shortcut routes bound: DOM${unsubscribeVoiceShortcut ? ' + app-menu IPC' : ' only (no Electron API — browser tab)'}`);
} catch (err) { console.warn('[voice] onVoiceShortcut subscribe failed', err); }

initApiConnection();

window.addEventListener('create-project', async (e) => {
  // (C1388, TPT160) Sole dispatcher is the unified open flow's setupKind chooser
  // (template.html's openOrCreateProject → "Set up as a new project"), which always
  // carries the already-picked folder in detail.projectPath. The fallback below is
  // defensive only — no live caller omits detail.
  const folder = e?.detail?.projectPath || await window.electronAPI?.selectFolder?.();
  if (!folder) return;
  projectCreationWizard.open({
    projectPath: folder,
    onComplete: async (detail) => {
      const res = await window.electronAPI?.completeProjectWizard?.(detail);
      if (!res?.ok) {
        utils.showToast(i18n.t('project.createFailed', { msg: res?.error || i18n.t('project.unknownError') }), 'error');
        return;
      }
      window.dispatchEvent(new CustomEvent('project-created', { detail: { projectPath: res.projectPath } }));
      // (TPT203) The project is usable, but a partial/failed preset seed leaves blank
      // placeholder tasks — say so. showToast auto-dismisses in ~2s, so also leave a
      // persistent card that survives the wizard closing and the board loading.
      const seedReport = buildPresetSeedReport(res.presetSeed, i18n.t);
      if (seedReport) {
        utils.showToast(seedReport.title, 'error');
        notificationCenter.pushNotification({ tag: 'preset-seed-failed', title: seedReport.title, body: seedReport.body, category: 'attention' });
      }
    },
  });
});
