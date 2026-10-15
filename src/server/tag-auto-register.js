'use strict';

// TPT623 — writes real one-line descriptions for tags a Task App UI save wants to use but the
// project registry doesn't have yet, so api-backend.js can register them (POST /tags) instead
// of failing the save with the C1439 "Unregistered tag(s)" gate. One prompt for every name,
// run through the project's default objective-chat provider (providers/one-shot.js). The
// caller still applies the C1038 rule (tag-registry-gate.js buildAutoRegistrations): a
// missing, empty or placeholder description means the tag stays unregistered.

const { runOneShotPrompt } = require('./providers/one-shot');

const DESCRIBE_TIMEOUT_MS = 90000;
const CONTEXT_MAX_CHARS = 600;

function buildDescribePrompt(names, context = {}) {
  const lines = [
    'You are writing short reference descriptions for task-tracker tags in a software project.',
    'Another AI agent will read ONLY these descriptions to decide which tags apply to a new task.',
    'For each tag below, write ONE plain sentence (max 150 chars) describing what kind of work',
    'the tag marks, inferred from its name. No marketing language, no "This tag...".',
  ];
  const title = typeof context.title === 'string' ? context.title.trim() : '';
  const description = typeof context.description === 'string' ? context.description.trim() : '';
  if (title || description) {
    lines.push('', 'The tags are being added to this task (context only):');
    if (title) lines.push(`Title: ${title.slice(0, 200)}`);
    if (description) lines.push(`Description: ${description.slice(0, CONTEXT_MAX_CHARS)}`);
  }
  lines.push(
    '',
    'Output ONLY a JSON array: [{"name": "...", "description": "..."}] — one entry per tag, same names.',
    'Do not use tools. Do not read files.',
    '',
    ...names.map((n, i) => `${i + 1}. "${n}"`),
  );
  return lines.join('\n');
}

// Accepts [{name, description}], {tags: [...]}, or {name: description}.
function describedMapFrom(parsed) {
  const out = new Map();
  const rows = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.tags)) ? parsed.tags
    : null;
  if (rows) {
    for (const r of rows) {
      if (r && typeof r.name === 'string' && typeof r.description === 'string') out.set(r.name, r.description);
    }
  } else if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out.set(k, v);
  }
  return out;
}

/**
 * @param {string[]} names - tag names to describe
 * @param {object} [opts]
 * @param {string} [opts.projectRoot]
 * @param {{title?: string, description?: string}} [opts.context] - the task being saved
 * @returns {Promise<Map<string, string>>} name -> raw description; empty on any failure
 */
async function describeTagsWithLlm(names, opts = {}) {
  const wanted = [...new Set((names || []).filter(n => typeof n === 'string' && n.trim()))];
  if (wanted.length === 0) return new Map();
  const run = opts.runOneShotPrompt || runOneShotPrompt;
  try {
    const parsed = await run(buildDescribePrompt(wanted, opts.context), {
      projectRoot: opts.projectRoot,
      timeoutMs: opts.timeoutMs || DESCRIBE_TIMEOUT_MS,
      parseJson: true,
    });
    return describedMapFrom(parsed);
  } catch (err) {
    console.warn(`[tag-auto-register] describe failed: ${err.message}`);
    return new Map();
  }
}

module.exports = { describeTagsWithLlm, buildDescribePrompt, describedMapFrom };
