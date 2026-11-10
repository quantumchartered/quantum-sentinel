# Airwallex sandbox: verified run

**Recorded sandbox run, November 10, 2026.** Real calls to `https://api.sandbox.airwallex.com` with a scoped sandbox key (simulated funds, synthetic supplier, no real money). API version header `2026-08-21`. Redacted responses are in [`fixtures/sandbox/`](../fixtures/sandbox/); no credential appears in any of them.

Reproduce, after putting a sandbox key in `.env` (see [SETUP.md](SETUP.md)):

```bash
pnpm sandbox check
pnpm sandbox fund --amount 60000
pnpm sandbox beneficiary
pnpm sandbox scenario-a --beneficiary <id from the previous step>
```

## Scenario A on the sandbox

`pnpm sandbox scenario-a` drives the product's own functions (the ones the console calls) against the real sandbox. Output of the recorded run, unedited apart from line wrapping:

```text
1. Invoice and original transfer (SANDBOX)
    original d7033415-… SCHEDULED request_id=33709a3f-…
2. Simulate SENT: the money has left, the supplier says it has not arrived
    provider: SENT
3. Policy decides
    WAIT: original:in_flight:SENT, replacement_would_risk_double_payment, deadline_passed_but_original_may_still_arrive
    investigator (mock-investigator): COMPLETED
4. Operator clicks "Resend anyway"
    BLOCKED: original:in_flight:SENT, replacement_would_risk_double_payment, deadline_passed_but_original_may_still_arrive
5. New evidence: simulate a bank return (FAILED, auto-cancelled by Airwallex)
    provider: CANCELLED failure 90802 Beneficiary bank returned (type INCORRECT_ROUTING)
6. Policy decides again
    REPLACE: original:confirmed_failed:BENEFICIARY_BANK_RETURNED, duplicate_fence:clear, balance:sufficient
    investigator: COMPLETED
7. Proposal, bound approval by a second person, executor sends the replacement
    execution SUCCEEDED
    replacement 463060da-… request_id=c82541c8-… (original used 33709a3f-…)
8. Simulate the replacement SENT, then PAID
    provider: PROCESSING
    provider: SENT
    provider: PAID
9. Resolve with the original's fate, post the books, reconcile, verify the audit chain
    RESOLVED: settled by REPLACEMENT; original RETURNED: BENEFICIARY_BANK_RETURNED
    reconciliation FINDINGS: UNMATCHED_PROVIDER_TRANSFER ×5
    audit chain verified (68 entries)
```

The five reconciliation findings are the five USD 100 probe transfers created while checking failure behaviour (below). They belong to no invoice, so reconciliation reports them instead of hiding them. The investigator was the labelled Mock AI: no Anthropic key was configured.

## Verified endpoints

| Endpoint | Observed | Fixture |
| --- | --- | --- |
| `POST /api/v1/authentication/login` | Token issued; a key's Client ID and API key must belong to the same key (a mismatch gives 401 `credentials_invalid`) | (none: token held in memory only) |
| `GET /api/v1/balances/current` | One row per currency, major units; USD read back exactly as `available_amount` | `*_balances_current.json` |
| `GET /api/v1/global_accounts` | Existing HK account in `PROCESSING`; listed with `required_features` objects | `*_global_accounts_list.json` |
| `POST /api/v1/global_accounts/create` | `US` / USD / LOCAL account created `ACTIVE`. The sandbox also credited USD 10,000,000 to the wallet | `*_global_account_create.json` |
| `POST /api/v1/simulation/deposit/create` | Response `PENDING`, balance usable at once (USD 10,060,000 after a 60,000 deposit) | `*_simulation_deposit_create.json` |
| `POST /api/v1/beneficiary_api_schemas/generate` | US / USD / ACH / COMPANY schema; requires `beneficiary.type`, `bank_details.bank_account_category`, state as `US-WA` | `*_beneficiary_api_schema_*.json` |
| `POST /api/v1/beneficiaries/create` | Created; needs `transfer_methods: ["LOCAL"]` (array). The response carries `beneficiary.bank_details`, which the executor hashes | `*_beneficiary_create.json` |
| `POST /api/v1/transfers/create` | New transfers start `SCHEDULED` (via the executor, the first read showed `PROCESSING`) | `*_transfer_create.json` |
| `POST /api/v1/simulation/transfers/{id}/transition` | `SENT` and `PAID` work; `FAILED` with a `failure_type` works after `SENT` | `*_simulation_transition_*.json` |
| `GET /api/v1/transfers/{id}` | Current failure shape: `failure.code`, `failure.message`, `failure.details.type` | `*_transfer_get_*.json` |

## Findings that changed the product

1. **A 500 can still take effect.** `SCHEDULED → PROCESSING` returned HTTP 500 `operation_failed`, yet the transfer was `PROCESSING` when read back. Sentinel already treats an ambiguous answer to a mutation as *uncertain* (look it up, never repeat it blindly); this is real evidence for that rule. `SCHEDULED → SENT` works directly.
2. **FAILED becomes CANCELLED in about 3 seconds.** A 200 ms poll saw `SENT` then `CANCELLED`, never `FAILED`. The failure details were still on the `CANCELLED` record, so nothing was lost; the event store keeps them either way.
3. **The failure `type` is not the cause in the sandbox.** Every simulated failure came back with `failure_type` / `details.type` `INCORRECT_ROUTING`, whatever was requested, while the code and message matched Airwallex's documented failure-code table:

   | Requested `failure_type` | Code and message returned | Documented? |
   | --- | --- | --- |
   | `BENEFICIARY_BANK_RETURNED` | 90802 Beneficiary bank returned | yes |
   | `CHANNEL_TIMEOUT` | 91402 Channel timeout | yes |
   | `SYSTEM_ERROR` | 91401 System error | yes |
   | `INSUFFICIENT_FUNDS` | 90602 Insufficient funds | no (the table lists 90604 Insufficient balance) |

   Policy now classifies a failure by its **documented code**, falling back to the type only when there is no documented code (`failureCause` in `packages/policy/src/decide.ts`, decision D72). An undocumented code such as 90602 therefore still escalates.
4. **The transition response uses the older shape** (`failure_reason: "90802: …"`, top-level `failure_type`), while `GET` returns the `failure` object. Sentinel records what `GET` returns.
5. **The beneficiary schema is stricter than the reference examples** (state codes like `US-WA`, a required account category). The CLI now checks every required field against the generated schema's patterns before it creates anything.

## Not yet verified

- Webhooks (`payout.transfer.*`): needs a public tunnel and a webhook registered in the sandbox web app. The backup poller covered this run.
- Duplicate `request_id` behaviour (PLAN.md §0.4 step 10).
- A live Claude investigation (no Anthropic key).
