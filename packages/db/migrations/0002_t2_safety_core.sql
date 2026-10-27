-- T2 safety core: obligations, the one-blocking-payment fence, incidents,
-- deterministic decisions, labelled evidence, bound approvals, the execution
-- outbox and the hash-chained audit log. Every table carries organization_id,
-- and cross-table references include it so rows can never point across tenants.

ALTER TABLE organizations ADD COLUMN replacement_fee_minor bigint NOT NULL DEFAULT 0 CHECK (replacement_fee_minor >= 0);
ALTER TABLE organizations ADD COLUMN reserve_floor_minor bigint NOT NULL DEFAULT 0 CHECK (reserve_floor_minor >= 0);

-- What we owe. One row per (supplier, invoice) per tenant, so a re-import cannot create a second payable.
CREATE TABLE obligations (
  id                uuid PRIMARY KEY,
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  supplier_ref      text NOT NULL,
  invoice_ref       text NOT NULL,
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  currency          char(3) NOT NULL,
  beneficiary_id    text NOT NULL,
  beneficiary_hash  text NOT NULL CHECK (beneficiary_hash ~ '^[0-9a-f]{64}$'),
  due_at            timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, supplier_ref, invoice_ref),
  UNIQUE (id, organization_id)
);

-- Payment attempts for an obligation.
--   INTENDED          approved and queued, not yet sent
--   DISPATCHED        provider accepted it (in flight or paid)
--   UNCERTAIN         we do not know if the provider created it
--   FAILED_CONFIRMED  terminal failure with a recorded failure type
--   NOT_SENT          the provider definitively rejected the create, or execution was blocked
-- Only FAILED_CONFIRMED and NOT_SENT release the duplicate fence.
CREATE TABLE payments (
  id                      uuid PRIMARY KEY,
  organization_id         uuid NOT NULL,
  obligation_id           uuid NOT NULL,
  role                    text NOT NULL CHECK (role IN ('ORIGINAL', 'REPLACEMENT')),
  predecessor_payment_id  uuid,
  request_id              text NOT NULL CHECK (char_length(request_id) BETWEEN 10 AND 50),
  provider_transfer_id    text,
  amount_minor            bigint NOT NULL CHECK (amount_minor > 0),
  currency                char(3) NOT NULL,
  beneficiary_id          text NOT NULL,
  state                   text NOT NULL CHECK (state IN ('INTENDED', 'DISPATCHED', 'UNCERTAIN', 'FAILED_CONFIRMED', 'NOT_SENT')),
  blocking                boolean GENERATED ALWAYS AS (state NOT IN ('FAILED_CONFIRMED', 'NOT_SENT')) STORED,
  failure_type            text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (obligation_id, organization_id) REFERENCES obligations (id, organization_id),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, request_id),
  UNIQUE (organization_id, provider_transfer_id),
  CHECK ((role = 'ORIGINAL') = (predecessor_payment_id IS NULL)),
  CHECK (state <> 'FAILED_CONFIRMED' OR failure_type IS NOT NULL)
);

-- INVARIANT 1: at most one blocking (pending, uncertain, in-flight or paid) payment per obligation.
CREATE UNIQUE INDEX payments_one_blocking_per_obligation
  ON payments (organization_id, obligation_id) WHERE blocking;

-- Identity and money of a payment never change; released payments never block again.
CREATE FUNCTION sentinel_guard_payment_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.obligation_id <> OLD.obligation_id
     OR NEW.request_id <> OLD.request_id OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.currency <> OLD.currency OR NEW.beneficiary_id <> OLD.beneficiary_id
     OR NEW.role <> OLD.role OR NEW.predecessor_payment_id IS DISTINCT FROM OLD.predecessor_payment_id THEN
    RAISE EXCEPTION 'payment % identity and amount are immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.provider_transfer_id IS NOT NULL AND NEW.provider_transfer_id IS DISTINCT FROM OLD.provider_transfer_id THEN
    RAISE EXCEPTION 'payment % provider transfer id cannot change', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state IN ('FAILED_CONFIRMED', 'NOT_SENT') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'payment % is terminal (%)', OLD.id, OLD.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER payments_guard BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION sentinel_guard_payment_update();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_mutation();

CREATE TABLE incidents (
  id                   uuid PRIMARY KEY,
  organization_id      uuid NOT NULL,
  obligation_id        uuid NOT NULL,
  original_payment_id  uuid NOT NULL,
  state                text NOT NULL CHECK (state IN ('OPEN', 'INVESTIGATING', 'RECOMMENDED', 'AWAITING_APPROVAL', 'EXECUTING', 'MONITORING', 'RESOLVED', 'ESCALATED')),
  recommendation       text CHECK (recommendation IN ('WAIT', 'REPLACE', 'ESCALATE')),
  version              integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  risk_flags           text[] NOT NULL DEFAULT '{}',
  escalation_reason    text,
  original_fate        text,
  settled_by           text CHECK (settled_by IN ('ORIGINAL', 'REPLACEMENT')),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (obligation_id, organization_id) REFERENCES obligations (id, organization_id),
  FOREIGN KEY (original_payment_id, organization_id) REFERENCES payments (id, organization_id),
  UNIQUE (id, organization_id),
  CHECK (state <> 'RESOLVED' OR (original_fate IS NOT NULL AND settled_by IS NOT NULL))
);
CREATE UNIQUE INDEX incidents_one_live_per_obligation
  ON incidents (organization_id, obligation_id) WHERE state NOT IN ('RESOLVED', 'ESCALATED');

-- Labelled evidence (AGENTS.md §2 pillar 1). Supplier text is stored with trusted = false.
CREATE TABLE evidence (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL,
  incident_id      uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('provider_fact', 'internal_record', 'synthetic_fixture', 'ai_interpretation', 'unknown')),
  source           text NOT NULL,
  ref              text,
  trusted          boolean NOT NULL,
  content          jsonb NOT NULL,
  content_hash     text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  captured_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (incident_id, organization_id) REFERENCES incidents (id, organization_id)
);
CREATE INDEX evidence_by_incident ON evidence (organization_id, incident_id, captured_at);

-- Every deterministic decision, with its inputs, for Decision Replay.
CREATE TABLE decisions (
  id                 uuid PRIMARY KEY,
  organization_id    uuid NOT NULL,
  incident_id        uuid NOT NULL,
  incident_version   integer NOT NULL,
  policy_version     text NOT NULL,
  recommendation     text NOT NULL CHECK (recommendation IN ('WAIT', 'REPLACE', 'ESCALATE')),
  reasons            text[] NOT NULL,
  inputs             jsonb NOT NULL,
  evidence_set_hash  text NOT NULL,
  decided_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (incident_id, organization_id) REFERENCES incidents (id, organization_id)
);

-- The exact action put in front of the approver.
CREATE TABLE proposed_actions (
  id                uuid PRIMARY KEY,
  organization_id   uuid NOT NULL,
  incident_id       uuid NOT NULL,
  incident_version  integer NOT NULL,
  action_type       text NOT NULL CHECK (action_type = 'REPLACE'),
  facts             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (incident_id, organization_id) REFERENCES incidents (id, organization_id),
  UNIQUE (id, organization_id)
);

CREATE TABLE approvals (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL,
  incident_id         uuid NOT NULL,
  proposed_action_id  uuid NOT NULL,
  binding             jsonb NOT NULL,
  key_version         text NOT NULL,
  signature           text NOT NULL CHECK (signature ~ '^[0-9a-f]{64}$'),
  approver_id         text NOT NULL,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (incident_id, organization_id) REFERENCES incidents (id, organization_id),
  FOREIGN KEY (proposed_action_id, organization_id) REFERENCES proposed_actions (id, organization_id),
  -- A proposal can be approved (and therefore executed) once.
  UNIQUE (proposed_action_id),
  UNIQUE (id, organization_id)
);

-- Outbox: one execution per approval and per payment. Committed before any HTTP call.
CREATE TABLE executions (
  id                 uuid PRIMARY KEY,
  organization_id    uuid NOT NULL,
  approval_id        uuid NOT NULL UNIQUE,
  payment_id         uuid NOT NULL UNIQUE,
  status             text NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'SUCCEEDED', 'UNCERTAIN', 'REJECTED', 'BLOCKED')),
  lease_until        timestamptz,
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  provider_response  jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (approval_id, organization_id) REFERENCES approvals (id, organization_id),
  FOREIGN KEY (payment_id, organization_id) REFERENCES payments (id, organization_id)
);

-- Hash-chained audit log, one chain per tenant. No forks (unique prev_hash), no gaps (unique seq).
CREATE TABLE audit_events (
  id               bigserial PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  seq              bigint NOT NULL CHECK (seq > 0),
  prev_hash        text NOT NULL,
  hash             text NOT NULL,
  occurred_at      text NOT NULL,
  actor            text NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  UNIQUE (organization_id, seq),
  UNIQUE (organization_id, prev_hash)
);

CREATE TRIGGER evidence_append_only BEFORE UPDATE OR DELETE ON evidence FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_mutation();
CREATE TRIGGER decisions_append_only BEFORE UPDATE OR DELETE ON decisions FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_mutation();
CREATE TRIGGER proposed_actions_append_only BEFORE UPDATE OR DELETE ON proposed_actions FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_mutation();
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON approvals FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_mutation();
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_mutation();
