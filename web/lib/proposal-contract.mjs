/**
 * @file Shared proposal limits and fixed validation diagnostics. No network, model
 * output, file paths or exception text is used to construct public messages.
 * Generation and validation import these same bounds; validation remains final.
 */
import { LIMITS } from './policy.mjs';

export const PROPOSAL_LIMITS = Object.freeze({
  summary: 1500, explanation: 600, listItems: 12, sourcePaths: 12,
  changes: LIMITS.changes, fileBytes: LIMITS.fileBytes, patchBytes: 120000,
  repairContextBytes: 160000, maxOutputTokens: 12000
});

// Only ordinary formatting/mapping mistakes can spend a repair attempt. Policy
// failures and insufficient inspected context stop rather than weaken a guard.
const definitions = {
  proposal_envelope: [true, 'Provider returned an invalid proposal envelope.'],
  proposal_summary: [true, 'Invalid proposal summary. Use 1–1500 characters.'],
  proposal_change_count: [true, 'A draft needs 1–10 file changes.'],
  proposal_change_fields: [true, 'Invalid change fields. Return path, action, content, reason and sourcePaths only.'],
  proposal_unsafe_path: [false, 'Unsafe path or unsupported change action.'],
  proposal_unsafe_content: [false, 'Unsafe or sensitive generated content. No repair will resend it.'],
  proposal_file_size: [true, 'A generated file exceeds the 60000-byte limit. Split the implementation within the existing file and patch limits.'],
  proposal_content_type: [true, 'Generated file content must be a string.'],
  proposal_reason: [true, 'Each change needs a short reason of 1–600 characters.'],
  proposal_source_refs: [true, 'Every change must cite 1–12 inspected source files, using their exact paths.'],
  proposal_duplicate_path: [true, 'Duplicate change path. Return one complete change per destination file.'],
  proposal_add_collision: [true, 'An added file would overwrite an existing path. Update it only if it was inspected, or use a new path.'],
  proposal_empty_file: [true, 'An added file must not be empty.'],
  proposal_uninspected_update: [false, 'An update targets destination content that was not inspected. More context is required; validation was not bypassed.'],
  proposal_noop_update: [true, 'Updates require changed destination content; omit unchanged files.'],
  proposal_patch_size: [true, 'Generated changes exceed the 120000-byte patch budget.'],
  proposal_path_collision: [true, 'File/directory collision in proposed changes.'],
  proposal_risks: [true, 'Invalid risks list. Use at most 12 nonempty strings of up to 600 characters each.'],
  proposal_checks: [true, 'Invalid suggested checks list. Use at most 12 nonempty strings of up to 600 characters each.'],
  proposal_json: [true, 'The AI response was not a valid JSON proposal.'],
  proposal_incomplete: [false, 'The AI response was incomplete. No draft was applied.'],
  proposal_refused: [false, 'The AI provider declined this request. No repair will retry a refusal.'],
  proposal_context_insufficient: [false, 'The model returned no changes because the selected context was insufficient. No speculative patch was applied.']
};
export const PROPOSAL_RULES = Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([code, [repairable, message]]) => [code, Object.freeze({ code, repairable, message })])
));

/** Return a known diagnostic with only a bounded, non-secret change index. */
export function proposalDiagnostic(code, changeIndex) {
  const rule = Object.hasOwn(PROPOSAL_RULES, code) ? PROPOSAL_RULES[code] : null;
  if (!rule) throw new Error('Unknown proposal validation rule');
  return { ...rule, ...(Number.isInteger(changeIndex) && changeIndex >= 0 && changeIndex < PROPOSAL_LIMITS.changes ? { changeIndex } : {}) };
}

/** Schema-supported pattern bounds share the validator's textual limits. */
function boundedString(max, description) {
  return { type: 'string', pattern: `^[\\s\\S]{1,${max}}$`, description };
}

/** Build the strict output schema; file-byte/path/context rules still run locally. */
export function proposalSchemaFor(inspectedSourcePaths) {
  const short = boundedString(PROPOSAL_LIMITS.explanation, 'Nonempty; at most 600 characters.');
  const sources = inspectedSourcePaths?.length ? { type: 'string', enum: [...new Set(inspectedSourcePaths)] } : { type: 'string' };
  return {
    type: 'object', additionalProperties: false, required: ['summary', 'changes', 'risks', 'suggestedChecks'],
    properties: {
      summary: boundedString(PROPOSAL_LIMITS.summary, 'Explain the same requested feature in at most 1500 characters.'),
      risks: { type: 'array', maxItems: PROPOSAL_LIMITS.listItems, items: short },
      suggestedChecks: { type: 'array', maxItems: PROPOSAL_LIMITS.listItems, items: short },
      changes: { type: 'array', maxItems: PROPOSAL_LIMITS.changes,
        description: '1–10 complete production files. Zero changes only for genuinely insufficient context; never invent missing interfaces.',
        items: { type: 'object', additionalProperties: false, required: ['path', 'action', 'content', 'reason', 'sourcePaths'],
          properties: {
            path: { type: 'string', description: 'Safe relative destination path. Updates require inspected content; additions must be absent from the inventory.' },
            action: { type: 'string', enum: ['add', 'update'] },
            content: { type: 'string', description: `Complete file, at most ${PROPOSAL_LIMITS.fileBytes} UTF-8 bytes; all files combined at most ${PROPOSAL_LIMITS.patchBytes} bytes.` },
            reason: short,
            sourcePaths: { type: 'array', minItems: 1, maxItems: PROPOSAL_LIMITS.sourcePaths, items: sources }
          }
        }
      }
    }
  };
}
