-- T1: tenants, verified provider events, append-only transfer observations,
-- rejected webhook attempts, and the outbound provider operation log.
-- Money is never stored here as floating point; raw provider payloads are kept
-- verbatim as evidence.

CREATE TABLE organizations (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Every webhook whose signature verified. One row per provider event id per tenant.
CREATE TABLE provider_events (
  id                   bigserial PRIMARY KEY,
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  provider             text NOT NULL CHECK (provider = 'airwallex'),
  provider_event_id    text NOT NULL,
  event_name           text NOT NULL,
  provider_account_id  text,
  provider_created_at  text,
  api_version          text,
  raw_body             bytea NOT NULL,
  body_sha256          text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  signature_timestamp  bigint NOT NULL,
  parse_error          text,
  received_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, provider_event_id)
);

-- Webhook attempts that failed verification. Kept for the attack scoreboard; never trusted.
CREATE TABLE webhook_rejections (
  id               bigserial PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  reason           text NOT NULL,
  body_sha256      text NOT NULL,
  body_bytes       integer NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now()
);

-- Everything we ever learned about a provider transfer, from any source.
-- Failure facts live on the row that first carried them and can never be overwritten.
CREATE TABLE transfer_observations (
  id                    bigserial PRIMARY KEY,
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  provider_transfer_id  text NOT NULL,
  source                text NOT NULL CHECK (source IN ('webhook', 'poll', 'create', 'reconcile')),
  provider_event_id     text,
  raw_status            text NOT NULL,
  failure_code          text,
  failure_message       text,
  failure_type          text,
  failure_reason_codes  text[] NOT NULL DEFAULT '{}',
  snapshot              jsonb NOT NULL,
  dedup_key             text NOT NULL,
  observed_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider_transfer_id, dedup_key),
  CHECK ((source = 'webhook') = (provider_event_id IS NOT NULL))
);
CREATE INDEX transfer_observations_lookup
  ON transfer_observations (organization_id, provider_transfer_id, id);

-- Outbound mutations we sent (or tried to send) to Airwallex.
CREATE TABLE provider_operations (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  kind             text NOT NULL,
  request_id       text,
  request_body     jsonb NOT NULL,
  body_sha256      text NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('PENDING', 'SUCCEEDED', 'REJECTED', 'UNCERTAIN')),
  response         jsonb,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (request_id IS NULL OR char_length(request_id) BETWEEN 10 AND 50)
);
-- A request_id is used for exactly one payload per tenant, forever (Airwallex only dedups for 7 days).
CREATE UNIQUE INDEX provider_operations_request_id
  ON provider_operations (organization_id, request_id) WHERE request_id IS NOT NULL;

-- Evidence tables are append-only.
CREATE FUNCTION sentinel_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER provider_events_append_only BEFORE UPDATE OR DELETE ON provider_events
  FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_mutation();
CREATE TRIGGER webhook_rejections_append_only BEFORE UPDATE OR DELETE ON webhook_rejections
  FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_mutation();
CREATE TRIGGER transfer_observations_append_only BEFORE UPDATE OR DELETE ON transfer_observations
  FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_mutation();
