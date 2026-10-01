/**
 * @file Bounded repair policy and sanitized feedback for a single durable job.
 * Active attempt metadata lives in the existing encrypted payload. Terminal jobs
 * keep a fixed error_code, not discarded source code. No schema migration needed.
 */
import { ProposalValidationError } from '../web/lib/core-base.mjs';
import { PROPOSAL_LIMITS, PROPOSAL_RULES, proposalDiagnostic } from '../web/lib/proposal-contract.mjs';
import { looksSensitive } from '../web/lib/policy.mjs';
export const MAX_REPAIR_ATTEMPTS = 2;

/** Read an immutable per-job budget. Legacy jobs without a budget remain single-attempt. */
export function repairProgress(value, charged = false) {
  const repairs = value?.request?.maxRepairAttempts ?? 0;
  const attempts = value?.generation?.attempts ?? (charged ? 1 : 0);
  if (!Number.isInteger(repairs) || repairs < 0 || repairs > MAX_REPAIR_ATTEMPTS ||
      !Number.isInteger(attempts) || attempts < 0 || attempts > repairs + 1) throw new Error('Invalid persisted repair budget');
  return { attempts, maxAttempts: repairs + 1, repairsUsed: Math.max(0, attempts - 1) };
}

/** Copy catalog fields only. An arbitrary exception/code is a validator bug, not AI feedback. */
export function validationDiagnostic(error) {
  if (error instanceof ProposalValidationError && Object.hasOwn(PROPOSAL_RULES, error.code)) {
    return proposalDiagnostic(error.code, error.diagnostic?.changeIndex);
  }
  return { code: 'validator_error', repairable: false,
    message: 'Repot encountered an internal validation error. No further generation was submitted; the operator must investigate the validator.' };
}

/**
 * Keep a bounded previous proposal only when it contains no sensitive-looking
 * data or binary text. No provider response envelope, token, raw exception or
 * refusal is persisted or resubmitted. All feedback remains untrusted model input.
 */
export function repairFeedback(error) {
  const diagnostic = validationDiagnostic(error);
  let previousProposal = null;
  if (diagnostic.repairable && error.proposal != null) {
    const text = JSON.stringify(error.proposal);
    if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= PROPOSAL_LIMITS.repairContextBytes &&
        !looksSensitive(text) && !text.includes('\\u0000')) previousProposal = JSON.parse(text);
  }
  return { diagnostic, previousProposal };
}

/** Fail closed unless this is a known repairable rejection within the saved attempt budget. */
export function canRepair(value, error, charged = false) {
  const progress = repairProgress(value, charged);
  return validationDiagnostic(error).repairable === true && progress.attempts > 0 && progress.attempts < progress.maxAttempts;
}

/** Persist one bounded, fixed-message diagnostic per failed generation attempt. */
export function nextRepairContext(value, feedback) {
  const diagnostic = proposalDiagnostic(feedback.diagnostic.code, feedback.diagnostic.changeIndex);
  const history = (value.generation?.diagnostics ?? []).slice(0, MAX_REPAIR_ATTEMPTS);
  return { ...value,
    generation: { ...value.generation, diagnostics: [...history, diagnostic].slice(-MAX_REPAIR_ATTEMPTS) },
    repair: { diagnostic, previousProposal: feedback.previousProposal }
  };
}
