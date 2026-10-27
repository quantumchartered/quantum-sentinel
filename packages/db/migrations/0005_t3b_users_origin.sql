-- T3b: operator identities and roles, incident origin labels, and who proposed an action.

-- Bearer-token users. Only the SHA-256 of the token is stored; the token is shown once at creation.
CREATE TABLE users (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  display_name     text NOT NULL,
  role             text NOT NULL CHECK (role IN ('OWNER', 'APPROVER', 'OPERATOR', 'VIEWER')),
  token_sha256     text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  disabled_at      timestamptz
);

-- Where an incident's transfers live, shown on every screen (AGENTS.md §13: label mock / sandbox).
--   SANDBOX           real Airwallex sandbox transfers
--   SANDBOX_SCENARIO  Scenario Lab run against the Airwallex sandbox
--   MOCK_SCENARIO     Scenario Lab run against Sentinel's in-memory MOCK provider (no Airwallex calls)
ALTER TABLE incidents ADD COLUMN origin text NOT NULL DEFAULT 'SANDBOX'
  CHECK (origin IN ('SANDBOX', 'SANDBOX_SCENARIO', 'MOCK_SCENARIO'));
ALTER TABLE incidents ADD COLUMN title text;

-- Four-eyes: the approver must not be the proposer.
ALTER TABLE proposed_actions ADD COLUMN proposed_by text NOT NULL DEFAULT 'unknown';
