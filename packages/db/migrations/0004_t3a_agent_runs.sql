-- T3a: one row per investigator run, written once when the run ends.
-- Records exactly what the model was asked, which tools it called, what it
-- cost, what it reported, and whether the grounding verifier accepted it.

CREATE TABLE agent_runs (
  id                 uuid PRIMARY KEY,
  organization_id    uuid NOT NULL,
  incident_id        uuid NOT NULL,
  incident_version   integer NOT NULL,
  model              text NOT NULL,
  status             text NOT NULL CHECK (status IN ('COMPLETED', 'REPORT_REJECTED', 'REFUSED', 'AI_UNAVAILABLE', 'LIMIT_EXCEEDED', 'NO_REPORT')),
  steps              integer NOT NULL CHECK (steps >= 0),
  input_tokens       bigint NOT NULL DEFAULT 0,
  output_tokens      bigint NOT NULL DEFAULT 0,
  cost_micro_usd     bigint NOT NULL DEFAULT 0,
  tool_calls         jsonb NOT NULL,
  evidence_shown     jsonb NOT NULL,
  report             jsonb,
  verification       jsonb,
  policy_recommendation text NOT NULL CHECK (policy_recommendation IN ('WAIT', 'REPLACE', 'ESCALATE')),
  error              text,
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (incident_id, organization_id) REFERENCES incidents (id, organization_id),
  -- An accepted report must have passed verification.
  CHECK (status <> 'COMPLETED' OR (report IS NOT NULL AND (verification->>'ok')::boolean))
);
CREATE INDEX agent_runs_by_incident ON agent_runs (organization_id, incident_id, finished_at);
CREATE TRIGGER agent_runs_append_only BEFORE UPDATE OR DELETE ON agent_runs FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_mutation();
