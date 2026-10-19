'use strict';

// Shared by browser fallback parsing and every objective provider. An empty,
// valid proposal batch is a completed planning decision, not a parsing failure.
function describeProposalResult(parsed, proposedCount = parsed?.changes?.length) {
  if (!Array.isArray(parsed?.changes)) return null;
  const status = parsed.changes.length ? 'cards' : proposedCount > 0 ? 'rejected' : 'empty';
  if (status !== 'empty') return { status, reason: '' };
  const text = value => typeof value === 'string' ? value.trim().slice(0, 2000) : '';
  let reason = text(parsed.no_changes_reason) || text(parsed.reason) || text(parsed.note);
  if (!reason && Array.isArray(parsed.existing_coverage)) {
    reason = parsed.existing_coverage.map(row => {
      const detail = text(row?.reason);
      return detail ? [text(row.id), detail].filter(Boolean).join(': ') : '';
    }).filter(Boolean).join('\n');
  }
  // Older models put their explanation in doc_updates instead of a reason.
  if (!reason && Array.isArray(parsed.doc_updates)) {
    reason = parsed.doc_updates.map(row => text(row?.summary)).filter(Boolean).join('\n');
  }
  return { status, reason: reason.slice(0, 4000) };
}

module.exports = { describeProposalResult };
