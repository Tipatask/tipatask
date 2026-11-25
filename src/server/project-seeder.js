'use strict';

const path = require('node:path');
const { applyPresetTemplate, applyBaseGeneralTemplate, seedPresetTasks } = require('../cli/seed-setup-tasks');
const { KB_MODE_COMPOSE, readProjectConfig, writeProjectConfig } = require('./project-config');

// Work domains are shared project metadata. A/B/C below controls onboarding only.

const PROJECT_KNOWLEDGE_TEMPLATE = '# {{PROJECT_NAME}} — Project knowledge\n\n## Goals and constraints\n\n## Sources and deliverables\n\n## Working practices\n';

const PRESET_HARNESSES = {
  software: {
    name: 'Software',
    guides: ['AGENTS.md', 'CLAUDE.md', '.claude/skills/tipatask-expert/SKILL.md'],
    planner: 'Identify the source files and symbols to change and the behavior to verify.',
    executor: 'Inspect the affected modules, implement the requested change and update their standing architecture documentation.',
    deliverables: 'Source changes, configuration, tests and architecture documentation.',
    verification: 'Exercise the affected entry points and run the relevant checks.',
    completion: 'Account for the requested behavior, verification results and any outstanding blockers.',
  },
  science: {
    name: 'Science',
    planner: 'Frame a testable question. Specify the population or sample, variables, units, comparison and analysis before interpreting results.',
    sources: 'Use original instrument records, versioned datasets and primary papers. Cite the dataset version, record ID or DOI beside each result.',
    executor: 'Preserve raw observations. Record inclusion and exclusion counts, missing values, unit conversions and ordered calculation steps from raw inputs to result.',
    deliverables: 'Methods and results report (Markdown or PDF) with a data dictionary and analysis table (CSV), or a labelled figure with its underlying values.',
    verification: 'Reproduce the reported statistic from the cited records. Check units, sample size and an appropriate uncertainty measure. State what the design can establish.',
    completion: 'Answer the question with the result, uncertainty and limits of inference. Identify any unavailable records that prevent verification.',
    kbSections: ['Dataset provenance and versions', 'Variables and units', 'Sampling and analysis protocols'],
  },
  marketing: {
    name: 'Marketing',
    planner: 'Choose an audience, channel and conversion event. Define a baseline, target, attribution window and the evidence needed for the channel decision.',
    sources: 'Use approved product claims, customer research and dated first-party search, ad or social analytics. Record the segment, channel, keyword or query intent and reporting period where applicable.',
    executor: 'Map the audience need to the offer, supported claim and call to action. For SEO or paid search, tie each keyword to observed intent. Label forecast performance separately from measured results.',
    deliverables: 'Campaign brief and channel-ready copy (Markdown), keyword map, editorial calendar or KPI table (CSV or spreadsheet).',
    verification: 'Trace claims to approved evidence, check CTA destinations, and recompute rates from event counts and eligible denominators for the same cohort and window.',
    completion: 'Deliver the asset and specify the metric, owner, measurement date and decision threshold.',
    kbSections: ['Audience and channel evidence', 'Approved claims and keyword intent', 'Conversion and attribution definitions'],
  },
  sales: {
    name: 'Sales',
    planner: 'Set the account, pipeline cutoff, accounting period and currency. Identify the deal stage, inventory or supplier constraints and decision owner.',
    sources: 'Use dated CRM snapshots, signed orders or quotes, invoices, inventory and supplier records, and the ledger. Preserve record IDs, agreed terms and revenue recognition basis.',
    executor: 'Separate weighted pipeline from booked and recognized revenue. Match demand to available units and lead times. Extend quantities by net prices and reconcile revenue, cost of goods and expenses to the P&L.',
    deliverables: 'Pipeline, fulfillment or P&L reconciliation (CSV or spreadsheet) with an account decision or exception note.',
    verification: 'Tie line items to source totals in one period and currency. Check discounts, returns, duplicate deals and supply shortfalls. Quantify each unexplained variance.',
    completion: 'Report reconciled figures, outstanding exceptions, owner and next action. Mark any unsupported total provisional.',
    kbSections: ['Pipeline stages and forecast weights', 'Fulfillment and supplier terms', 'Margin and P&L definitions'],
  },
  finance: {
    name: 'Finance',
    planner: 'Frame the financial decision with an as-of date, time zone, reporting currency, horizon and comparison scenario.',
    sources: 'Use dated filings, statements, central-bank series or identified exchange quotes. For securities or crypto, record the instrument, venue, price timestamp and FX basis.',
    executor: 'Separate observed inputs from estimates. Show formulas, units, signs, fees, FX conversion and rounding so each result can be recalculated.',
    deliverables: 'Reconciliation, cash-flow model or scenario table (spreadsheet or CSV with formulas documented), plus a dated decision and risk note.',
    verification: 'Recalculate from the source values, reconcile opening to closing balances when relevant, and show the effect of a downside assumption. Flag stale quotes, liquidity and material exposure.',
    completion: 'Date the result and disclose assumptions, downside and data gaps that could change the decision.',
    kbSections: ['Market data and valuation conventions', 'Accounting and FX policies', 'Risk assumptions and scenarios'],
  },
  health: {
    name: 'Health',
    planner: 'Define the health or activity goal, baseline, time available and user-reported restrictions. Identify questions requiring a licensed professional.',
    sources: 'Use current public-health or clinical guidelines for the relevant population, primary studies for narrow claims, and the person’s clinician-issued plan and logs for individual limits and baseline. Cite issuer and date.',
    executor: 'Translate applicable guidance into a bounded routine with duration, intensity, recovery and monitoring. Respect clinician restrictions. Refer symptoms, contraindications, diagnosis or treatment decisions to a qualified professional.',
    deliverables: 'Activity and recovery schedule, tracking sheet (CSV), or cited evidence summary with safety limits and referral criteria.',
    verification: 'Check guideline applicability, units, workload and recovery against the stated limits. Specify when to stop and seek care, including urgent help for red flags.',
    completion: 'Give the review date and safe adjustment or referral criteria. Leave unresolved clinical decisions to the treating professional.',
    kbSections: ['Guideline sources and scope', 'Workload and recovery measures', 'Safety limits and referral criteria'],
  },
  home: {
    name: 'Home',
    planner: 'Set the routine, people or servings, owner, time, inventory and equipment model. Identify food, allergy and device hazards relevant to the work.',
    sources: 'Use household inventory and preferences, tested recipes, food-safety authority guidance and the manufacturer manual for the exact device model.',
    executor: 'Sequence the work around household constraints. Give exact quantities, units, durations and safe settings. For device routines include a safe manual stop. Route work beyond the manual to a qualified technician.',
    deliverables: 'Household checklist, scaled recipe and shopping list, meal plan or device routine with settings and manual stop (Markdown or printable table).',
    verification: 'Check quantities, timing, cost and available capacity. Recalculate scaled amounts after subtracting stock. Verify applicable temperatures, loads and device limits against the cited source.',
    completion: 'Record owners, timing and an observable done condition, plus any safety prerequisite before the routine can run.',
    kbSections: ['Household routines and roles', 'Supply units and scaling rules', 'Device manuals and safety limits'],
  },
  'personal-growth': {
    name: 'Personal Growth',
    planner: 'Use the person’s stated goal, baseline and constraints to define an observable target, unit and deadline they can influence.',
    sources: 'Use the person’s own calendar, practice logs, stated priorities and authorized feedback. Label self-reported measures and assumptions.',
    executor: 'Schedule repeatable actions around available time. Define the count or rating rubric, logging method, checkpoint and a smaller fallback action for missed sessions.',
    deliverables: 'Practice plan (Markdown), dated habit tracker (CSV) or review worksheet with baseline and target.',
    verification: 'Check the weekly time budget, compute progress against the baseline with the same measure, and distinguish missed observations from observed zeroes.',
    completion: 'Name the first action, review cadence, next review date and rule for continuing or adjusting the plan.',
    kbSections: ['Goal measures and baselines', 'Practice routines and constraints', 'Review cadence and adjustment rules'],
  },
};

function selectedPresetIds(presets) {
  if (!Array.isArray(presets)) return ['software'];
  const selected = Object.keys(PRESET_HARNESSES).filter(id => presets.includes(id));
  return selected.length ? selected : ['software'];
}

function resolvePresetHarness(presets) {
  const selected = selectedPresetIds(presets);
  const entries = selected.map(id => ({
    id, guides: [`.tipatask/guides/${id}.md`], ...PRESET_HARNESSES[id],
  }));
  return { entries, software: selected.includes('software'), softwareOnly: selected.length === 1 && selected[0] === 'software' };
}

function projectKnowledgeTemplate(harness) {
  const sections = [PROJECT_KNOWLEDGE_TEMPLATE.trimEnd()];
  for (const entry of harness.entries) {
    if (entry.kbSections) sections.push('## ' + entry.name, ...entry.kbSections.map(title => '### ' + title));
  }
  return sections.join('\n\n') + '\n';
}

// The first line is part of the planner's saved task description. Quoted source
// material further down cannot change the work domains a task runs with.
function taskHarness(harness, description) {
  if (harness.entries.length < 2 || typeof description !== 'string') return harness;
  const firstLine = description.trimStart().split('\n', 1)[0].trimEnd();
  const match = /^Work presets: (.+)$/.exec(firstLine);
  if (!match) return harness;
  const ids = match[1].split(',').map(id => id.trim());
  if (!ids.every(id => harness.entries.some(entry => entry.id === id))) return harness;
  return resolvePresetHarness(ids);
}

function projectHarness(projectRoot) {
  const cfg = projectRoot && readProjectConfig(projectRoot);
  return resolvePresetHarness(cfg?.projectPresets);
}

// Older linked checkouts have no local copy of the work presets. Reconcile only
// a matching project detail response, after the backend has verified its identity.
function syncProjectPresets(projectRoot, project, baseUrl) {
  const cfg = projectRoot && readProjectConfig(projectRoot);
  if (!cfg?.API_BASE_URL || !baseUrl || project?.id == null || String(cfg.API_PROJECT_ID) !== String(project.id) ||
      String(cfg.API_BASE_URL).replace(/\/+$/, '') !== String(baseUrl).replace(/\/+$/, '')) return;
  const presets = selectedPresetIds(project.projectPresets ?? cfg.projectPresets);
  if (JSON.stringify(cfg.projectPresets) === JSON.stringify(presets)) return;
  if (cfg.projectPresets || !resolvePresetHarness(presets).softwareOnly) {
    const { refreshHarnessTemplates } = require('../cli/install-templates');
    refreshHarnessTemplates(projectRoot, path.resolve(__dirname, '../..'), { presets });
  }
  writeProjectConfig(projectRoot, { ...cfg, projectPresets: presets });
}

function formatPresetRules(entry, role) {
  return [
    entry[role],
    entry.sources && 'Sources: ' + entry.sources,
    'Deliverables: ' + entry.deliverables,
    'Verify: ' + entry.verification,
    'Complete: ' + entry.completion,
    entry.kbSections && 'Standing KB sections: ' + entry.kbSections.join(' / ') + '.',
  ].filter(Boolean).join('\n');
}

function presetDirective(harness, role) {
  // The original bundled prompts already express the complete Software-only workflow.
  if (harness.softwareOnly) return '';
  return [
    role === 'planner' ? 'Project work presets — apply only the domains relevant to the requested outcome.' :
      'Deliver and verify this task’s own output using the relevant presets below. Use the parent objective and sibling deliverables only as context.',
    role === 'planner' && harness.entries.length > 1 &&
      'For each new task, start its description with a separate line "Work presets: <ids>". Choose only the IDs needed for its own deliverable from ' +
      harness.entries.map(entry => entry.id).join(', ') + '. Keep the prefix and IDs literal in every language. Separate multiple IDs with commas. Carry the chosen evidence and checks into the task. Link dependent deliverables by task key.',
    ...harness.entries.map(entry => `- ${entry.name}: ${formatPresetRules(entry, role)}`),
  ].filter(Boolean).join('\n');
}

async function readProjectHarness(backend, projectRoot) {
  let project;
  try {
    project = await backend?.getProjectSettings?.();
  } catch (err) {
    console.warn(`[harness] Could not load project work presets: ${err.message}`);
  }
  const harness = project?.projectPresets ? resolvePresetHarness(project.projectPresets) : projectHarness(projectRoot);
  return { harness, groupingEnabled: Boolean(project?.use_objective_grouping ?? true) };
}

async function projectObjectivePrompt(backend, projectRoot, message) {
  const { harness, groupingEnabled } = await readProjectHarness(backend, projectRoot);
  const presetRules = presetDirective(harness, 'planner');
  if (!presetRules) return { systemPrompt: message.systemPrompt, presetRules };
  const { buildObjectiveSystemPrompt } = require('../objective-system-prompt.mjs');
  const status = await require('./status-roles').fetchStatusContext(backend);
  const systemPrompt = buildObjectiveSystemPrompt({
    ...status, presetRules, originTaskKey: message.originTaskKey,
    groupingEnabled,
  });
  return { systemPrompt, presetRules };
}

// (TPT9316) The creation wizard's preset A, "compose the knowledge base as you go". Its new
// project seeds no starter tasks, gets only the base templates (no preset overlay), and its
// .tipatask/config.json carries KB_MODE: 'compose'. Presets B/C ('original-specification',
// 'existing-code') keep their preset templates and starter tasks.
const COMPOSE_PRESET = 'compose-as-you-go';

function isComposePreset(preset) {
  return preset === COMPOSE_PRESET;
}

/** Config keys a preset adds to the new project's .tipatask/config.json. */
function presetConfigFields(preset) {
  return isComposePreset(preset) ? { KB_MODE: KB_MODE_COMPOSE } : {};
}

/** Whether a preset seeds starter tasks (callSeedPresetTasks). Compose mode starts empty. */
function presetSeedsTasks(preset) {
  return !isComposePreset(preset);
}

/**
 * Copy the project templates into the project root: the harness guides (CLAUDE.md, AGENTS.md,
 * .claude/) and work-domain guides, then the Software onboarding overlay or the base knowledge outline.
 * Non-fatal — errors are logged.
 */
function copyTemplates(preset, projectPath, presetDescription) {
  try {
    const { refreshHarnessTemplates } = require('../cli/install-templates');
    refreshHarnessTemplates(projectPath, path.resolve(__dirname, '../..'));
    if (!projectHarness(projectPath).software) applyBaseGeneralTemplate(projectPath, { software: false });
    else if (isComposePreset(preset)) applyBaseGeneralTemplate(projectPath);
    else applyPresetTemplate(preset, projectPath, presetDescription || null);
  } catch (err) {
    console.warn(`[project-seeder] copyTemplates failed: ${err.message}`);
  }
}

/**
 * Seed preset starter tasks via HTTP (no template copy — copyTemplates handles that).
 * Non-fatal — never throws. Returns `{ seeded, failed }` from seedPresetTasks, or
 * `{ seeded: 0, failed: null, error }` when the call itself threw, so the caller can tell a
 * partial seed apart from a clean one and from a crash (TPT203).
 */
async function callSeedPresetTasks(preset, { apiBaseUrl, token, projectId, presetDescription } = {}) {
  try {
    return await seedPresetTasks(preset, { apiBaseUrl, token, projectId, presetDescription });
  } catch (err) {
    console.warn(`[project-seeder] callSeedPresetTasks failed: ${err.message}`);
    return { seeded: 0, failed: null, error: err.message };
  }
}

module.exports = {
  PROJECT_KNOWLEDGE_TEMPLATE, projectKnowledgeTemplate, selectedPresetIds, resolvePresetHarness,
  projectHarness, taskHarness, readProjectHarness, syncProjectPresets, presetDirective, formatPresetRules, projectObjectivePrompt,
  copyTemplates, callSeedPresetTasks,
  COMPOSE_PRESET, isComposePreset, presetConfigFields, presetSeedsTasks,
};
