/** @file Lazy production wiring for resumable drafts. No secrets/database are accessed at module import. */
import { db } from './db.mjs';
import { seal, open } from './crypto.mjs';
import { env, intEnv } from './env.mjs';
import { githubTokenForUser, snapshotRepository } from './github.mjs';
import { analyze } from '../web/lib/core.mjs';
import { featureText } from '../web/lib/core-base.mjs';
import { buildProposalRequest, reviewFromAIResponse } from '../web/lib/ai.mjs';
import { createDraftJobStore } from './draft-job-store.mjs';
import { createBackgroundAI } from './background-ai.mjs';
import { createDraftJobs } from './draft-jobs.mjs';

/** Wire the existing engine, encryption, quota and GitHub access into a new request-local service. */
export function draftService() {
  return createDraftJobs({
    store: createDraftJobStore({ pool: db(), seal, open,
      draftLimit: intEnv('REPOT_DAILY_DRAFT_LIMIT', 20, 1, 1000),
      reviewTtlMinutes: intEnv('REPOT_REVIEW_TTL_MINUTES', 60, 10, 1440) }),
    provider: createBackgroundAI({ apiKey: env('OPENAI_API_KEY') }),
    validateFeature: featureText,
    /** Read only authorized immutable revisions. No GitHub token is written into a job. */
    prepare: async (request, userId, signal) => {
      const token = await githubTokenForUser(userId);
      signal.throwIfAborted();
      const [source, destination] = await Promise.all([
        snapshotRepository(token, request.sourceRepo, { signal }),
        snapshotRepository(token, request.destinationRepo, { signal })
      ]);
      signal.throwIfAborted();
      const { context } = analyze(source.snapshot, destination.snapshot, request.feature);
      return { source, destination, context };
    },
    /** Build the same pinned model/prompt/schema request as foreground generation. */
    buildRequest: value => buildProposalRequest({ source: value.source.snapshot, destination: value.destination.snapshot, context: value.context, repair: value.repair ?? null }),
    /** Apply deterministic test relocation and structural review before saving anything publishable. */
    reviewResponse: (response, value) => reviewFromAIResponse(response, { source: value.source.snapshot, destination: value.destination.snapshot, context: value.context })
  });
}
