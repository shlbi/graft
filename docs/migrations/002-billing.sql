-- Additive, opt-in migration. Never run automatically during builds or HTTP requests.
BEGIN;
CREATE TABLE IF NOT EXISTS repot_billing_checkout_refs (
  reference text PRIMARY KEY CHECK (reference ~ '^repot_[A-Za-z0-9_-]{32}$'),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  livemode boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS repot_billing_refs_owner ON repot_billing_checkout_refs(user_id,livemode,created_at DESC);
CREATE TABLE IF NOT EXISTS repot_billing_subscriptions (
  subscription_id text PRIMARY KEY,
  session_id text UNIQUE NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  customer_id text NOT NULL,
  livemode boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS repot_billing_subscriptions_owner ON repot_billing_subscriptions(user_id,livemode,created_at DESC);
COMMIT;
