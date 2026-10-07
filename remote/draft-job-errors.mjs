/** @file Public, fixed draft-job errors. Never serialize a provider/DB exception or abort reason. */
import { PROPOSAL_RULES } from '../web/lib/proposal-contract.mjs';

export const JOB_MESSAGES = Object.freeze({
  subscription_required: 'An active REPOT Pro subscription is required for REPOT-funded AI. Open https://getrepot.com/pricing. No new AI request was submitted.',
  context_budget_exceeded: 'The dependency plan exceeds one bounded draft context. No generation was started. Inspect the plan and select precise source entrypoints/destination integration files; staged execution is not yet available.',
  ...Object.fromEntries(Object.entries(PROPOSAL_RULES).map(([code, rule]) => [code, rule.message])),
  validator_error: 'Repot encountered an internal validation error. No further generation was submitted; the operator must investigate the validator.',
  repair_budget_exhausted: 'The saved repair budget is exhausted. No extra generation was submitted.',
  background_consent_required: 'Background drafting needs explicit consent to temporary provider-side storage for asynchronous generation and polling. No job was submitted.',
  invalid_request: 'Choose two distinct owner/repo names, a feature, and an 8–80 character requestKey. Reuse that key for retries of the same request.',
  job_not_found: 'This draft job does not exist or belongs to a different account.',
  request_key_conflict: 'That requestKey belongs to a different transfer. Do not change the feature when retrying the original job.',
  too_many_jobs: 'Too many active or newly created jobs. Resume an existing job instead of submitting more transfers.',
  draft_limit: 'The daily draft allowance has been reached. No new AI request was submitted.',
  setup_required: 'The resumable-draft database migration has not been applied. The operator must apply docs/migrations/001-draft-jobs.sql before enabling this workflow.',
  job_expired: 'This job expired. No successful transfer is claimed. Start a new job only after an explicit user request.',
  preparation_failed: 'Repository access or context selection failed. No AI generation or repository write was performed.',
  provider_rejected: 'The AI provider rejected this request. Check model access and server configuration; do not automatically create another draft.',
  submission_unknown: 'Submission was interrupted before its provider ID could be saved. Generation may have been accepted and billed. Repot will not resubmit automatically.',
  response_unavailable: 'The provider response is no longer retrievable. No review was created; do not silently replace the requested feature.',
  provider_failed: 'The provider did not complete a valid response. No review was created.',
  invalid_proposal: 'The generated proposal did not pass Repot validation. No review was created and no repository files were changed.',
  service_unavailable: 'Repot could not finish this step. Resume the same job/requestKey rather than starting a new generation.'
});

/** An error whose code maps to fixed public text; the underlying cause remains private. */
export class DraftJobError extends Error {
  constructor(code) { super(JOB_MESSAGES[code] ?? JOB_MESSAGES.service_unavailable); this.code = code; }
}

/** Convert failures to a non-secret MCP result, retaining only known machine-readable codes. */
export function publicJobError(error) {
  const code = error?.code === '42P01' ? 'setup_required' : Object.hasOwn(JOB_MESSAGES, error?.code) ? error.code : 'service_unavailable';
  return { error: { code, message: JOB_MESSAGES[code] }, retryAutomatically: false, notice: 'No repository changes were performed by draft generation.' };
}
