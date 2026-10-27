-- T2: double-entry ledger and reconciliation runs.
-- Accounts (per tenant, per currency):
--   WALLET            asset: money in the Airwallex wallet
--   IN_TRANSIT        asset: sent to the provider, not yet paid or returned
--   SUPPLIER_PAYABLE  liability: what we owe suppliers
--   EXPENSE           expense: the purchase the obligation pays for
-- Amounts are signed minor units: debit positive, credit negative. Every journal sums to zero.

CREATE TABLE ledger_entries (
  id               bigserial PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  journal_key      text NOT NULL,
  line_no          smallint NOT NULL CHECK (line_no > 0),
  account          text NOT NULL CHECK (account IN ('WALLET', 'IN_TRANSIT', 'SUPPLIER_PAYABLE', 'EXPENSE')),
  currency         char(3) NOT NULL,
  amount_minor     bigint NOT NULL CHECK (amount_minor <> 0),
  obligation_id    uuid,
  payment_id       uuid,
  memo             text NOT NULL,
  posted_at        timestamptz NOT NULL DEFAULT now(),
  -- Posting the same business event twice is a no-op, never a second journal.
  UNIQUE (organization_id, journal_key, line_no)
);
CREATE INDEX ledger_by_obligation ON ledger_entries (organization_id, obligation_id);

CREATE FUNCTION sentinel_check_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unbalanced record;
BEGIN
  SELECT currency, sum(amount_minor) AS total INTO unbalanced
    FROM ledger_entries
   WHERE organization_id = NEW.organization_id AND journal_key = NEW.journal_key
   GROUP BY currency
  HAVING sum(amount_minor) <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % is unbalanced in % by %', NEW.journal_key, unbalanced.currency, unbalanced.total
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;

-- Checked at COMMIT, so a journal can be inserted line by line inside one transaction.
CREATE CONSTRAINT TRIGGER ledger_journal_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION sentinel_check_journal_balanced();

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_mutation();

CREATE TABLE reconciliation_runs (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  started_at       timestamptz NOT NULL DEFAULT now(),
  ok               boolean NOT NULL,
  findings         jsonb NOT NULL
);
CREATE TRIGGER reconciliation_runs_append_only BEFORE UPDATE OR DELETE ON reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_mutation();
