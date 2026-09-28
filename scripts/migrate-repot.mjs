import {db} from '../remote/db.mjs';
await db().query(`
CREATE TABLE IF NOT EXISTS repot_review (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  source_repo text NOT NULL,
  destination_repo text NOT NULL,
  destination_revision text NOT NULL,
  payload text NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  published_url text,
  branch_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS repot_review_user_created_idx ON repot_review(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS repot_review_expiry_idx ON repot_review(expires_at);
CREATE TABLE IF NOT EXISTS repot_usage (
  user_id text NOT NULL,
  usage_day date NOT NULL,
  drafts integer NOT NULL DEFAULT 0,
  publishes integer NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,usage_day)
);
`);
console.log('Repot application migration complete');
await db().end();
