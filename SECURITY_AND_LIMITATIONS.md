# Security and limitations

Quantum Sentinel is a hackathon build on the **Airwallex sandbox**. It is not production software and has never moved real money. This page lists what protects money, what protects data, and what is known to be missing. Every control below has tests; the commands are in the [README](README.md).

## The money boundary

| Control | Where | Proof |
| --- | --- | --- |
| The AI cannot move money. Its only write tool is `propose_action`, which creates a proposal | `apps/api/src/agent/tools.ts` | Attack suite (AI-*), eval cases |
| Code decides WAIT / REPLACE / ESCALATE. The AI's report must match, or the verifier rejects it | `packages/policy/src/decide.ts`, `apps/api/src/agent/verifier.ts` | Unit tests, mutation-checked |
| At most one live payment per invoice: a partial unique index on a generated `blocking` column, plus row locks | `packages/db` migration 0002 | Real-Postgres races; fast-check; TLC model (`spec/`) |
| Replace only after a confirmed failure with a recorded, replaceable type; a timeout, SENT or a bare CANCELLED is never proof | `decide.ts`, `transfer-history.ts` | Unit and property tests, eval matrix |
| An uncertain send is never retried as a new transfer: same `request_id`, look up first, keep the lock | `packages/db/src/execution.ts` | Integration tests; TLC rows `no-stable-request-id`, `pre-fix` |
| Approvals are HMAC-signed over 12 bound fields (amount, currency, beneficiary and its details hash, evidence-set hash, provider-state version...), expire after 15 minutes and are used once | `packages/policy/src/approval.ts` | Each bound field mutated → rejected |
| Four-eyes: whoever proposed a payment cannot approve it; agent proposals always need a person | `approveProposal` | API and attack tests |
| Everything is re-checked under lock right before the provider call (finality, balance with fee and reserve, beneficiary details, approval) | `executeReplacement` | Integration tests |
| Supplier text is untrusted data. Bank-detail change requests and prompt injection are detected in code and always escalate | `packages/policy/src/text-signals.ts` | 16 unit tests, attack suite |
| Fail closed: a decoder, balance, policy or model error leads to WAIT or ESCALATE, never a payment | throughout | Tests with failing or stalled dependencies |
| A resolved incident reopens and escalates if PAID later fails or the replaced payment turns out to have been PAID | `recheckResolvedIncident` in `packages/db/src/execution.ts` | API tests (mutation-checked) and a browser test |

The arrival and cost estimate (`packages/policy/src/estimate.ts`) is **advisory**. It is computed from illustrative priors, never feeds `decide()`, and never prices a replacement that policy forbids.

## Data and access

- **Sandbox only.** The Airwallex client refuses any base URL other than `https://api.sandbox.airwallex.com`. The production AgentOS MCP is never used.
- **Secrets** live only in a git-ignored `.env`. `.env.example` has no values. The agent never sees Airwallex credentials.
- **Logs** redact `authorization`, `x-signature` and `x-api-key` headers. Sandbox fixtures are redacted before they are saved.
- **Users** sign in with bearer tokens. Only SHA-256 hashes are stored. Demo tokens are written once to git-ignored `.local/demo-tokens.json`, never logged. The console keeps the token in `sessionStorage`.
- **Roles**: Owner, Approver, Operator, Viewer, checked on every API route.
- **Tenant isolation**: every query is scoped by organization ID at the repository layer; cross-tenant reads and approvals are covered by tests.
- **Webhooks** are verified with HMAC-SHA256 over the timestamp and raw body before parsing, rejected when stale or from the future, deduplicated, limited to 256 KiB, and applied monotonically (a late or replayed event never regresses state or erases a captured failure).
- **Audit**: an append-only, hash-chained log (a database trigger rejects UPDATE and DELETE); `pnpm audit:verify` finds the first altered entry.
- **The AI run** is bounded: 12 steps, 180 s, 60,000 output tokens. Tool calls, tokens and cost are stored per run. An unknown tool call is refused and audited.

## Known limitations

**Not yet proven against real services**
- Scenario A has run once end to end on the real Airwallex sandbox ([docs/SANDBOX-RUN.md](docs/SANDBOX-RUN.md)). Webhooks and duplicate `request_id` handling have not been exercised against it yet; the backup poller covered that run.
- In the sandbox every failure carries the type `INCORRECT_ROUTING`; Sentinel classifies failures by Airwallex's documented failure code instead, and escalates on an undocumented code.
- The investigator has only run with scripted MOCK models. Real-model citation discipline, verifier pass rate and cost per run are unmeasured.

**Safety-model assumptions** (see [spec/README.md](spec/README.md))
- A transfer Airwallex reports FAILED never delivers money later; Airwallex de-duplicates `request_id`; a definite rejection means no transfer exists; lookup by `request_id` sees every transfer; nobody pays the supplier outside Sentinel.
- The TLA+ model is checked only up to 3 workers, 3 replacements and 4 claims, makes no liveness claim, and its match to the code is by review and replay tests, not a refinement proof.
- PAID is treated as settled when an incident resolves, although Airwallex documents that PAID can still fail. Resolved incidents are therefore re-checked (worker tick and every reconciliation run): a late failure of the settling payment, a PAID on the replaced payment, or a history conflict reopens the incident and escalates it to a person. The failed payment keeps blocking the invoice, nothing is re-sent automatically, and the ledger books the return. Detection is only as fast as the webhook or the next poll.
- The beneficiary hash uses `bank_details`, a shape not yet confirmed in the sandbox. If it is missing, execution is blocked.

**Product gaps**
- Webhooks and the backup poller serve one tenant (`SENTINEL_ORGANIZATION_ID`). Per-tenant provider connections and webhook secrets are not built.
- Fees are not posted to the ledger. The executor uses `LOCAL`, `goods_purchased`, and source currency = payment currency.
- Scenario Lab in the console has no SANDBOX mode yet; the sandbox scenario runs from the CLI (`pnpm sandbox scenario-a`) and its incident then appears in the console. The MOCK provider keeps its wallet in memory.
- Supplier-text screening is pattern-based and can be evaded by paraphrase. The beneficiary-details check at execution is the hard stop.
- The audit chain detects edits, deletions and reordering. On its own it does not detect truncation of the newest entries or a privileged rewrite of the whole chain; exported checkpoints are not built.
- Bearer tokens have no expiry or rotation, and there is no SSO, CSRF protection (not needed for bearer headers) or rate limiting.
- The Docker image runs TypeScript through `tsx` without a compile step.

**Estimates**
- The arrival curve, delay cost (0.1% of the amount per day overdue), review cost (USD 75) and review delay (8 h) are our own illustrative numbers, not measured data. They exist only for USD and the LOCAL rail.

## Reporting a problem

This is a private hackathon repository. Report issues to the founder directly, not in a public tracker.
