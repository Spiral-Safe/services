BEGIN;

-- Serialize replicas that run this idempotent migration from their init
-- containers during a rolling deploy.
SELECT pg_advisory_xact_lock(742813690164331537);

CREATE TABLE IF NOT EXISTS billing_plans (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]{1,63}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  active_wallet_limit integer CHECK (active_wallet_limit IS NULL OR active_wallet_limit >= 0),
  transaction_limit integer CHECK (transaction_limit IS NULL OR transaction_limit >= 0),
  wallet_unit_amount integer CHECK (wallet_unit_amount IS NULL OR wallet_unit_amount >= 0),
  transaction_unit_amount integer CHECK (transaction_unit_amount IS NULL OR transaction_unit_amount >= 0),
  stripe_product_id text,
  stripe_price_id text,
  metronome_product_id text,
  metronome_rate_card_id text,
  demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE billing_plans
  ADD COLUMN IF NOT EXISTS metronome_rate_card_id text;

CREATE UNIQUE INDEX IF NOT EXISTS billing_plans_stripe_product_unique
  ON billing_plans(stripe_product_id) WHERE stripe_product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_plans_stripe_price_unique
  ON billing_plans(stripe_price_id) WHERE stripe_price_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_plans_metronome_product_unique
  ON billing_plans(metronome_product_id) WHERE metronome_product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_plans_metronome_rate_card_unique
  ON billing_plans(metronome_rate_card_id) WHERE metronome_rate_card_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_accounts (
  id uuid PRIMARY KEY,
  tenant text NOT NULL UNIQUE CHECK (tenant ~ '^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  status text NOT NULL CHECK (status IN ('active','past_due','suspended')),
  plan_id text NOT NULL REFERENCES billing_plans(id),
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  metronome_customer_id text NOT NULL UNIQUE,
  metronome_stripe_mapping_verified_at timestamptz,
  metronome_verified_stripe_customer_id text,
  metronome_verified_customer_id text,
  metronome_verified_plan_id text,
  metronome_verified_rate_card_id text,
  billing_period_start timestamptz NOT NULL,
  billing_period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (billing_period_end > billing_period_start)
);

ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS metronome_stripe_mapping_verified_at timestamptz;
ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS metronome_verified_stripe_customer_id text;
ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS metronome_verified_customer_id text;
ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS metronome_verified_plan_id text;
ALTER TABLE billing_accounts
  ADD COLUMN IF NOT EXISTS metronome_verified_rate_card_id text;

CREATE TABLE IF NOT EXISTS billing_api_keys (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  prefix text NOT NULL UNIQUE CHECK (length(prefix) BETWEEN 8 AND 32),
  secret_hash text NOT NULL UNIQUE CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  users text[] NOT NULL CHECK (cardinality(users) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS billing_api_keys_account_idx
  ON billing_api_keys(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_console_users (
  id uuid PRIMARY KEY,
  account_id uuid REFERENCES billing_accounts(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('developer','admin')),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CHECK ((role='developer' AND account_id IS NOT NULL) OR
         (role='admin' AND account_id IS NULL))
);

CREATE TABLE IF NOT EXISTS billing_console_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES billing_console_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_console_sessions_expiry_idx
  ON billing_console_sessions(expires_at);

CREATE TABLE IF NOT EXISTS billing_usage_events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('active_wallet','transaction_signed')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  wallet_key text,
  status text NOT NULL CHECK (status IN ('reserved','committed')),
  occurred_at timestamptz NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (account_id, metric, idempotency_key),
  CHECK ((status='reserved' AND committed_at IS NULL) OR
         (status='committed' AND committed_at IS NOT NULL))
);

ALTER TABLE billing_usage_events
  ADD COLUMN IF NOT EXISTS reserved_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS billing_usage_period_idx
  ON billing_usage_events(account_id, metric, occurred_at)
  WHERE status IN ('reserved','committed');
CREATE INDEX IF NOT EXISTS billing_usage_reservation_idx
  ON billing_usage_events(reserved_at) WHERE status='reserved';

CREATE TABLE IF NOT EXISTS billing_usage_outbox (
  id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
  transaction_id text NOT NULL UNIQUE,
  customer_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN
    ('spiral_active_wallet','spiral_transaction_signed')),
  event_timestamp timestamptz NOT NULL,
  properties jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT to_timestamp(0),
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_usage_outbox_pending_idx
  ON billing_usage_outbox(next_attempt_at, created_at) WHERE state='pending';

CREATE TABLE IF NOT EXISTS billing_stripe_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  state text NOT NULL CHECK (state IN ('processing','processed')),
  received_at timestamptz NOT NULL,
  processed_at timestamptz
);

COMMIT;
