// Keep this contract aligned with the API's task-service.js VALID_AGENT_ASSIGNEES.
// Picker model/row IDs belong in claudeModel/codexModel/piModel, never agentAssignee.
export const VALID_AGENT_ASSIGNEES = Object.freeze(['human', 'claude', 'codex', 'pi']);

export function normalizeAgentAssignee(value) {
  return VALID_AGENT_ASSIGNEES.includes(value) ? value : null;
}
