# Phase 0 — Payment Ops Incident Commander

Prepared October 27, 2026. **Planning only; awaiting the user's review before Phase 1.**

## 1. Goal and scope

Investigate one delayed supplier obligation, explain a grounded WAIT / REPLACE / ESCALATE decision, obtain human approval, and execute a replacement only after deterministic safety checks. All funds, accounts, emails, and suppliers are synthetic or Airwallex sandbox resources. Never connect production endpoints or the production AgentOS MCP.

Selected first slice: USD local payments, no FX, one sandbox business, a pre-registered synthetic beneficiary, and one authenticated operator. The user delegated this scope choice ("do what is best"). Use the requested TypeScript / Fastify / PostgreSQL / Drizzle / Zod stack, Claude tool use, React + Vite, Vitest + fast-check, and TLC. Dependencies, model identifier, and tool payloads will be pinned during their implementation phases.

The team supplies these dates: build October 27–November 13, 2026; finalists November 15; Demo Day November 19. Target Phase 1 by October 30, Phase 2 by November 4, advanced work November 5–9, submission preparation November 10–12, buffer November 13. These are planning dates, not independently verified event deadlines.

## 2. Sources and contract corrections

Read the [builder guide](https://airwallexdev.com/guide), [connection instructions](https://airwallexdev.com), and [official API introduction](https://www.airwallex.com/docs/api/introduction). The developer lab itself states that it is not official API documentation. Exact fields come from the API reference and Docs MCP, then sandbox contract checks.

Detailed evidence: [API research](API-RESEARCH.md), [webhook research](WEBHOOK-RESEARCH.md). Registration and verification status: [SETUP.md](SETUP.md).

Important changes from the brief:

- Candidate pin: `x-api-version: 2026-08-21`. Since `2026-06-30`, current transfer responses use `failure.code`, `failure.message`, and `failure.details.type` rather than the legacy top-level failure fields. Simulation still accepts `failure_type`. Keep raw evidence and decode by the observed contract; do not silently mix shapes. [Versioning](https://www.airwallex.com/docs/api/versioning), [changelog](https://www.airwallex.com/docs/api/changelog)
- Current beneficiary schema endpoint is `POST /api/v1/beneficiary_api_schemas/generate`; the guide's `/beneficiaries/schema` is not the current reference path. Beneficiary creation and deposit simulation do not document a `request_id` field. Resolve per-endpoint deduplication without inventing fields. [Beneficiaries](https://www.airwallex.com/docs/api/payouts/beneficiaries), [deposit simulation](https://www.airwallex.com/docs/api/simulation/deposits)
- `PAID` can later fail. `FAILED` auto-cancels within seconds. Webhook `version` denotes API schema version, not event order. These require changes to the naive success/failure model. [Transfer statuses](https://www.airwallex.com/docs/payouts/transfers/create-a-transfer/transfer-statuses), [webhook envelope](https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events)

No authenticated sandbox resource calls have been completed. Payload fixtures, scopes, account version, fee behavior, failure timing, and arrival/refund evidence remain unverified against this account. If docs disagree, stop that integration step and ask with the conflicting sources; continue independent work only.

## 3. Provider transfer state machine

Main flow for current API generations, with optional Airwallex approval states kept separate from our app approval:

```mermaid
stateDiagram-v2
  [*] --> SCHEDULED
  SCHEDULED --> PROCESSING
  SCHEDULED --> OVERDUE
  SCHEDULED --> CANCELLED
  OVERDUE --> PROCESSING
  OVERDUE --> CANCELLED
  PROCESSING --> SENT
  PROCESSING --> FAILED
  SENT --> PAID
  SENT --> FAILED
  PAID --> FAILED
  FAILED --> CANCELLED
  CANCELLED --> [*]
```

This diagram summarizes the [documented transfer lifecycle](https://www.airwallex.com/docs/payouts/transfers/create-a-transfer/transfer-statuses), not every rail-specific condition. Optional provider approval states include `IN_APPROVAL`, `APPROVAL_RECALLED`, `APPROVAL_REJECTED`, and `APPROVAL_BLOCKED`. We do not use provider approval workflows for the initial demo. Unknown or legacy states block execution until explicitly mapped.

Store provider status independently from application finality. `FAILED` is failure evidence, not permission to release the duplicate fence immediately. `CANCELLED` alone does not identify the cause. `PAID` supports monitoring, not a claim that the recipient irrevocably received funds.

Sandbox scenario control uses the documented `next_status` and `failure_type`; the initial bank-return path uses `SENT → FAILED` with `BENEFICIARY_BANK_RETURNED`, followed by observed cancellation. Verify the actual transitions before marking this scenario runnable. Simulation commands are operator/dev scripts, never investigator tools. [Simulation reference](https://www.airwallex.com/docs/api/simulation/transfers/api)

## 4. Incident state machine

Main lifecycle: `OPEN → INVESTIGATING → RECOMMENDED → AWAITING_APPROVAL → EXECUTING → MONITORING → RESOLVED / ESCALATED`.

| Transition | Required condition |
| --- | --- |
| OPEN → INVESTIGATING | Obligation identified and linked to original transfer; initial evidence recorded |
| INVESTIGATING → RECOMMENDED | Policy evaluated; structured report validates; every factual claim has supported evidence |
| RECOMMENDED → AWAITING_APPROVAL | Immutable proposal, evidence hash, amount, beneficiary snapshot, and state versions frozen |
| AWAITING_APPROVAL → EXECUTING | REPLACE approved; signature, actor, freshness, finality, balance, limits, and duplicate fence all pass atomically |
| AWAITING_APPROVAL → MONITORING | WAIT acknowledged; schedule next review and deadline without creating a payment |
| AWAITING_APPROVAL → INVESTIGATING | Rejection, expired approval, or new material evidence; old approval permanently invalidated |
| EXECUTING → MONITORING | Provider acceptance reconciled, or dispatch result uncertain; uncertainty keeps fence/reservation and prevents another send |
| MONITORING → INVESTIGATING | New evidence or review deadline; re-evaluate without releasing any payment fence |
| MONITORING → RESOLVED | Original fate recorded; obligation satisfied with arrival evidence under the declared sandbox contract; no unknown dispatch or unresolved contradiction |
| Any nonterminal state → ESCALATED | Fraud signal, changed bank details, unprovable finality, unsupported contract, or unrecoverable execution uncertainty |
| RESOLVED → INVESTIGATING / ESCALATED | Late contradictory event reopens the incident and invalidates prior conclusions; it never automatically permits a new transfer |

Risk flags block payment as soon as they are recorded; an operator cannot approve away a bank-detail swap. An escalation records the reason and assigned operator in the console; no external email is sent by default. ESCALATED may return to INVESTIGATING only through an authenticated manual action with new evidence and a fresh approval cycle.

## 5. The duplicate-payment boundary

The desired invariant is **at most one final, successful recipient payment per obligation**. Provider `PAID` events are not the definition of final settlement. Code can prove its own scheduling and authorization behavior under explicit provider assumptions; it cannot prove how an external bank behaves.

For the initial replacement demo, require all of the following:

1. Original transfer belongs to the same account and immutable supplier obligation; original amount, currency, and beneficiary agree with the obligation.
2. Captured authoritative bank-return failure evidence plus a current `CANCELLED` observation; a bare cancellation, recall request, or timeout is insufficient.
3. The chosen sandbox scenario demonstrates the return/refund and non-arrival assumptions. Record transfer-linked reconciliation evidence. An increase in aggregate wallet balance alone is not proof of this original's refund. If no documented correlation is available, require explicit, visibly simulated fixture evidence for the demo or escalate; do not fabricate provider fields.
4. No known prior `PAID` state for the original in the initial implementation. Late-paid returns are escalated pending a broader finality model. Missing/inconsistent history is uncertainty, not proof that `PAID` never occurred.
5. No risk hold, changed bank data, unconsumed execution, pending/unknown prior dispatch, or satisfied obligation.
6. Fresh available balance covers principal, fees, reserve floor, and other local reservations; a valid bound approval authorizes this exact intent.

Enforcement design:

- Enforce one canonical obligation per `(account, approved supplier identity, normalized invoice reference)` and unique ownership of each `(account, provider transfer ID)`. Imports without a reliable invoice identity require review; they cannot silently create a second payable obligation. These constraints must survive concurrent imports.
- Lock the obligation row in every transition affecting payment eligibility. A partial unique index allows only one blocking payment intent per obligation; pending, unknown, in-flight, and successful intents continue to block successors.
- Confirmed failed intent release and new replacement allocation happen in one transaction. A fulfilled-obligation record remains a permanent fence against another payment. Enforce writes through a narrow DB role and a checked transition function/trigger so direct writes cannot silently clear that fence.
- A unique operation ID / provider request ID binds the exact immutable request payload. Never reuse an ID for a different body; never create a new ID because of a timeout or double click.
- Durable outbox: transactionally consume one approval and persist the intent, reservation, audit entry, and dispatch job. Commit before HTTP. Persist outcome in a new transaction. Never hold a database transaction open across an external request.
- At ingress, advance a relevant-evidence generation under the obligation lock. Dispatch authorization requires its reducer watermark to cover every committed relevant event and invalidates approval if the evidence generation changed. Unmapped account events conservatively block related account dispatch until classified. Test a persisted PAID event with a deliberately delayed reducer. Recheck these gates when claiming the outbox job, not only when clicking Approve.
- Retrieve the authoritative beneficiary immediately before authorization, compare its normalized bank-details hash, and bind the exact validated executable payload. The supplier cannot select a new beneficiary. If the API only accepts a mutable beneficiary ID without a version precondition, document and enforce the demo assumption that no out-of-band editor changes it; unresolved drift blocks execution. A final read alone cannot remove that external race.
- Worker crash, response loss, or duplicate job: reconcile by request ID and retain the fence. A lease prevents concurrent workers; request-ID stability protects retries. After provider deduplication retention expires, an unknown operation requires escalation, not retransmission.
- External changes during dispatch cannot be prevented by our database lock. If a contradiction arrives after dispatch has begun, record it, block all further payments, and escalate. The proof explicitly depends on terminal-failure non-arrival and provider idempotency assumptions.

Provider transfer deduplication is documented as seven days, so permanent application uniqueness is essential. The current docs expose more than one duplicate-error spelling; normalize documented aliases and reconcile the original result rather than treating them as permission to replace. [Transfer API](https://www.airwallex.com/docs/api/payouts/transfers), [error codes](https://www.airwallex.com/docs/payouts/errors/transfer-error-codes)

## 6. Architecture and proposed data model

```text
apps/api          Fastify API, operator authentication, webhook ingress
apps/worker       event reducer, backup poller, outbox dispatcher, investigation jobs
apps/console      React + Vite operator console
packages/domain   money, states, deterministic policy, shared Zod contracts
packages/db       Drizzle schema, migrations, constraints, transaction helpers
packages/airwallex typed version-pinned sandbox boundary
packages/agent    Claude tool schemas, report validation, evidence checks
packages/audit    canonical encoding, approval binding, hash chain verification
spec/             TLA+ model, TLC configuration, assumptions, saved results
scripts/          sandbox preparation, simulation, replay, audit verification
```

These directories are proposed, not scaffolded in Phase 0.

| Entity | Essential data and guarantees |
| --- | --- |
| accounts / operators | Explicit sandbox account identity and operator role; every query scoped to that account |
| obligations | Unique account+supplier+normalized invoice identity, positive minor-unit amount, currency, due time, approved beneficiary snapshot/hash, fulfillment fence, aggregate version, ingress/reducer watermarks |
| incidents | Obligation link, lifecycle, policy version, latest report, owner, next review time, resolution evidence |
| transfers / payment_intents | Original/replacement role, predecessor link, unique account+provider ID ownership, stable request ID, payload hash, raw status, normalized failure, finality classification, blocking flag |
| events / webhook_inbox | Immutable event ID, provider ID, account, source, raw body/hash, signature result, API version, occurred_at, received_at, local aggregate version; unique provider event ID within account |
| failure_observations | Transfer, evidence ID, first-seen time, original raw fields and normalized cause; append-only; never erased by a later snapshot |
| evidence | Source, trust class, immutable content/hash, relevant facts, captured time, effective time; email content is untrusted data |
| recommendations | Structured claims and evidence IDs, WAIT/REPLACE/ESCALATE, policy inputs/result, model ID, prompt version, evidence-set hash |
| approvals | Bound intent, actor, nonce, expiry, signature/key version, consumed/invalidated state; single consumption under lock |
| operations / outbox | Unique operation, exact request payload/hash, retry history, UNKNOWN outcome, lease/fencing token, next attempt; all persisted before external mutation |
| wallet_reservations | Currency/account/operation, principal+fee budget, expiry policy that cannot release unknown dispatches; serialize concurrent local spending |
| audit_entries / checkpoints | Per-incident sequence, canonical payload, previous hash, current hash, actor/time, periodic independent checkpoint |

All monetary storage uses PostgreSQL BIGINT and TypeScript bigint; API-facing internal JSON uses validated integer strings. Currency exponents come from an explicit supported-currency table; reject unsupported currencies and fractional minor units. Convert transfer/balance major-unit fields exactly once at the Airwallex boundary with decimal-safe serialization/parsing and range checks. Conversion is field-specific: optional application-fee fields have a different documented unit and are out of scope (see API-RESEARCH.md). Never use floating-point arithmetic for money.

Every durable state change, event append, reservation update, and audit append is a DB transaction. Rebuild projections only from immutable event history, with reducer/policy versions recorded. Retain both observed-at order (what the agent knew) and provider occurrence time; replay cannot retroactively give the agent later evidence.

## 7. Ingress, polling, authentication, and retries

- Verify the webhook HMAC over timestamp plus raw bytes before accepting evidence. Validate signature encoding, compare in constant time, enforce a configurable replay window, and use the configured subscription secret. No JSON parse/re-serialization before verification.
- Durably insert and deduplicate verified events before HTTP 200, then reduce asynchronously. An invalid signature never creates trusted evidence. Known duplicates acknowledge without applying a second transition.
- Assign our own aggregate version under lock. Use provider timestamps as evidence only; a total rank of statuses is invalid because PAID can fail. Equal-time conflicts, stale polls, and unknown events trigger reconciliation or escalation.
- Preserve captured failure facts even when the next observation is CANCELLED without details. A webhook arriving after a poll can enrich history without regressing the reconciled projection. Polling cannot recover every missed transient failure; unresolved gaps stay visible.
- Refresh bearer tokens from returned `expires_at` with a buffer and a single shared refresh; never log keys or tokens. Sandbox base URL is an exact allowlist; reject unsafe redirects and production hosts.
- Classify retries per endpoint: safe reads use bounded exponential backoff/jitter and respect rate limits; keyed mutations reuse the stored body and key; unkeyed mutations get a local operation key and no automatic uncertain replay. Authentication and schema reads must not receive invented idempotency fields.
- Balance reads are preflight checks, not provider reservations. Serialize local currency reservations and still handle provider insufficient-funds responses. Spending outside this app is an external assumption to monitor.

Exact signature/delivery fields and auth/balance references are in [WEBHOOK-RESEARCH.md](WEBHOOK-RESEARCH.md). Phase 1 will test a public HTTPS tunnel exposing only the webhook endpoint.

## 8. Typed tools and approval contract

These are our proposed application tools, not claimed Airwallex endpoint names. All inputs/outputs use Zod; account context comes from the session, never arbitrary model input.

| Tool | Access and result |
| --- | --- |
| get_incident | Read lifecycle, obligation, internal versions, and risk holds |
| get_transfer_evidence | Read original/replacement snapshots and retained failure observations with evidence IDs |
| get_available_balance | Read normalized available cash, freshness, and reservations |
| read_supplier_evidence | Read synthetic email/invoice text explicitly marked untrusted |
| get_policy_assessment | Read deterministic safety gates, deadlines, fees, and expected-cost comparisons |
| get_audit_timeline | Read prior actions and evidence at an internal version |
| propose_replacement | Persist a draft proposal only if deterministic proposal gates pass; returns blocked reasons or proposal ID; cannot send money |
| submit_incident_report | Validate structured WAIT/REPLACE/ESCALATE claims and their citations |

Only authenticated operator endpoints can approve/reject. Only the internal worker can execute an approved replacement. The LLM cannot call simulation, create/change a beneficiary, approve its own proposal, choose credentials, or directly call Airwallex money APIs.

Approval HMAC covers canonical `(account ID, incident ID, obligation ID, action, amount_minor, currency, beneficiary ID, beneficiary-details hash, evidence-set hash, original transfer ID, transfer-state version, incident version, policy version, nonce, expiry, approver ID)`. The minimum required tuple from the brief is included. The server signs after authenticated approval, stores key version, and verifies again at dispatch authorization. Any bound change invalidates approval; consume it once in the execution transaction. Include session protection/CSRF controls where relevant.

Audit entries use canonical serialization and a hash chain with transactionally assigned sequence numbers. Verification detects edits, deletions in the middle, and reordering. A chain alone does not stop privileged rewriting or suffix truncation: pin/export a trusted checkpoint and disclose this limitation. No secrets or full bank details enter the audit log.

## 9. Evidence, economics, and LLM behavior

Model output is a constrained JSON report: recommendation, supported claims with evidence IDs, conflicts, missing evidence, policy explanation, and next review/escalation reason. Render factual sentences from validated claims so every sentence has evidence. Citation presence is not semantic proof: validate known status/amount/identity/time predicates against typed facts; reject unsupported causal claims or mark explicitly as hypothesis. The model cannot override verifier failure.

Supplier email cannot change approved bank data. Deterministic matching and a bank-change risk flag block replacement even if the model follows a malicious instruction. Contradictions preserve both sources and force review. Limit tool iterations, tokens, and wall time; on model/network failure produce a deterministic hold/escalation with evidence.

Expected-cost policy is evaluated only over safety-eligible actions. Use integer monetary costs and fixed-point probabilities: waiting cost from delay/deadline; replacement cost from fees and residual loss/recovery assumptions; escalation cost from review effort/delay. For an ineligible replacement, its cost is effectively forbidden regardless of low estimated arrival probability. Priors by rail/status/elapsed time are illustrative synthetic parameters, visibly labeled. Version these inputs and show sensitivity; no claim of calibrated prediction without real data.

## 10. Phases and acceptance gates

| Phase | Work | Evidence required before the user approves the next phase |
| --- | --- | --- |
| 0 — plan | Instructions, Git, MCP setup, official research, plan/questions, provenance | Document consistency and secret-ignore checks; accurate MCP status; no app tests claimed |
| 1 — sandbox plumbing | Workspaces, Compose, Postgres migrations, versioned client, auth, money conversion, reconciliation, scripts, signed webhook inbox and poller | Unit tests plus real-Postgres integration tests; authenticated read contract; captured sandbox fixtures; SENT→FAILED→CANCELLED reason-retention test; one-command clean setup |
| 2 — working core | State machine, DB fences/reservations/outbox, bound approvals, basic hash chain, evidence/report checks, Claude investigator, operator console | Three demo paths; concurrent approval/retry/crash tests; zero unauthorized or duplicate sends in core adversarial cases; inspectable audit |
| 3 — advanced | Expand claim verification, attack scoreboard, audit checkpoints, cost model, TLC/fast-check refinement, replay | Measured scenario results; saved seeds/traces; TLC config, state count, assumptions and result; replay equality |
| 4 — ship | README/GIF, EVAL.md (8–10 cases), video <5 min, setup rehearsal, security/idempotency/race/secrets self-review | Fresh-clone Compose run, recorded demo, actual results table, accurate prior-work record, no invented pass counts |

After every phase: run the applicable checks, update PROGRESS.md and decisions, make a small reviewable commit, summarize results, and wait for the user's OK. Move foundational approvals and attack checks into Phase 2; Phase 3 expands them. Defer advanced presentation before weakening core safety.

### Demo and evaluation matrix

| Scenario | Expected result |
| --- | --- |
| Original SENT within window | WAIT; review scheduled, no replacement |
| Captured bank return, reconciled cancellation/refund, sufficient cash | REPLACE proposal; single human approval; replacement PAID plus simulated arrival evidence and recorded original fate → RESOLVED |
| Supplier requests new bank details | ESCALATE; payment blocked |
| Deadline passed but original could still arrive | ESCALATE; cost model cannot bypass finality |
| Terminal failure but insufficient available balance/fee reserve | ESCALATE; no send |
| FAILED immediately becomes bare CANCELLED | Original reason retained; same safe decision as complete history, otherwise escalate |
| Replayed/out-of-order webhooks and stale polls | One effective application per event; no erased failure facts or unsafe regression |
| Double click / concurrent approvals / worker crash after API acceptance | At most one created replacement, stable request ID, unknown outcome reconciled |
| Evidence/amount/beneficiary/state changes during approval | Approval invalidated before dispatch; new review required |
| Prompt injection or late original PAID evidence | Block unauthorized actions; late-payment conflict escalated |

Actual outcomes, time-to-recommendation, and duplicates blocked are **not run** in Phase 0. Attack scoreboard will distinguish attempted violations, blocked attempts, and succeeded violations; report zero only after running the declared suite.

### Meaningful tests and formal model

- Money round trips (including 0/2/3-decimal currencies), invalid precision/overflow, exact request serialization, token refresh races, endpoint-specific retry policy.
- Real PostgreSQL tests for constraints and competing transactions; duplicate invoice/transfer imports; persisted-but-unreduced evidence at dispatch; external beneficiary drift; process crashes on both sides of HTTP; cross-obligation reservation races; seven-day provider-window expiry.
- Signed raw-body fixtures, tampered bytes/timestamps, duplicates, reversed delivery, same-time conflicts, failure retention and API-version incompatibility.
- fast-check command sequences against the real reducer/persistence layer: webhook arrival, poll, approval, rejection, dispatch/retry, crash/restart, evidence mutation. Record shrinkable counterexamples and seeds.
- TLC model in `/spec` includes obligations, original/replacement attempts, approvals, message duplication/reordering/loss, retries, unknown dispatches, and provider deduplication bounds. Invariants cover one blocking intent, valid consumed approval, and at most one final successful recipient payment.
- Model explicit provider assumptions: terminal confirmed failure cannot later settle; retries with the same ID inside retention create one transfer; all app writes use the guarded path; no out-of-band payment for this obligation. Include adversarial traces violating assumptions to show why escalation is necessary. Never label finite-state model checking as an unconditional proof about real banks.

## 11. Risks and unresolved decisions

| Risk / unknown | Planned response |
| --- | --- |
| Finality/refund/arrival evidence not fully specified by docs | Agree the sandbox fixture contract; escalate ambiguous real observations; no broad guarantee |
| API docs / guide / Docs MCP retrieve mixed versions | Explicit pin and versioned fixtures; contract failure blocks writes |
| Unkeyed setup/simulation mutations | Local operation tracking and manual reconciliation after uncertainty; no blind retries |
| Late events and failed webhooks | Persist raw events; poll as backup; preserve gaps and captured reasons |
| New bank instructions / prompt injection | Immutable beneficiary snapshot plus deterministic hold |
| External wallet spending | Fresh available cash, local reservations, provider error handling |
| HMAC key compromise / audit rewrite | Independent secrets and key versions; checkpoints; explicit trust boundary |
| Deadline and scope | Ship three complete paths first, then advanced layers in the specified order |
| MCP access / local tooling | Docs MCP verified; Developer OAuth attempt timed out and needs user login; Claude CLI and Java not found on PATH; Docker engine and Compose verified |

## 12. Questions for the team before implementation

1. Scope choice resolved: user delegated the choice; use USD/LOCAL/no-FX and escalate failures after PAID. SWIFT remains a later extension.
2. Is the sandbox business approved, and can you complete Developer MCP login? Then place sandbox Client ID/API key in root `.env` as described in SETUP.md; never paste them into chat.
3. Which Quantum Chartered repositories, code, or patterns must be disclosed as prior work?
4. Can we explicitly use labeled simulated transfer-return/arrival evidence for the demo where sandbox APIs do not establish irreversible settlement? Without it, ambiguous finality must ESCALATE.
5. After reviewing this plan and the contract discrepancies, do you approve Phase 1? No app code will be written until that OK.
