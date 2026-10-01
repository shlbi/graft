-- Repot's resumable draft lifecycle. Additive: existing auth/review tables stay intact.
-- Apply only through an explicitly approved operator migration, never at build/startup.
CREATE TABLE IF NOT EXISTS public.repot_draft_job (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','prepared','submitting','running','completed','failed','cancelled')),
  payload text,
  response_id text,
  review_id text,
  cancel_requested boolean NOT NULL DEFAULT false,
  charged boolean NOT NULL DEFAULT false,
  cleanup_pending boolean NOT NULL DEFAULT false,
  error_code text,
  lease_token text,
  lease_until timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  provider_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  UNIQUE(user_id, request_key),
  CHECK (length(request_key) BETWEEN 8 AND 80),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (state <> 'running' OR response_id IS NOT NULL),
  CHECK (state <> 'completed' OR review_id IS NOT NULL),
  CHECK (state NOT IN ('completed','failed','cancelled') OR payload IS NULL)
);
CREATE INDEX IF NOT EXISTS repot_draft_job_owner_created_idx ON public.repot_draft_job(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS repot_draft_job_expiry_idx ON public.repot_draft_job(expires_at);
