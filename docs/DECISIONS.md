# Phase 0 decisions

October 27, 2026. Design proposals awaiting the user's Phase 0 review; no implementation implied.

| ID | Decision | Reason / remaining condition |
| --- | --- | --- |
| D01 | TypeScript workspaces; Fastify, PostgreSQL, Drizzle, Zod; React + Vite | Follows the requested stack; one API/worker and one console keep the demo small. Dependency versions will be selected and locked in Phase 1. |
| D02 | USD, LOCAL, no FX, one synthetic supplier obligation per demo | User delegated the choice ("do what is best"). Avoids exchange-rate and fee complexity while exercising the core invariant. |
| D03 | Candidate API pin `2026-08-21`; normalize current `failure` objects | Current official versioning and changelog differ from the guide. Validate account and webhook contracts before implementing mutating calls. |
| D04 | Preserve all failure observations; assign internal aggregate versions | Provider API version and timestamps are not a reliable transfer event sequence. |
| D05 | Finality gate precedes cost optimization | Expected-cost estimates must never authorize a replacement while the original may still arrive. |
| D06 | Initially escalate late failures after `PAID` | Keeps the first proof and demo scoped; bank settlement finality remains an external assumption. |
| D07 | Bring bound approvals, core adversarial checks, and the audit chain into Phase 2 | The original phase ordering delays foundations needed for safe execution. Phase 3 expands them after the core works. |
| D08 | Persistent operation records + outbox; network calls outside DB transactions | A database transaction cannot atomically commit an Airwallex request. Unknown results retain the fence and reconcile. |
| D09 | Per-endpoint idempotency support | Never invent `request_id` or an idempotency header where it is absent from the contract. No blind replay of unsupported mutations. |
| D10 | Claude sees typed read tools and a proposal tool only | Financial credentials, execution, beneficiary editing, and sandbox simulation remain outside the model's toolset. |
| D11 | Evidence verifier accepts constrained factual claims | Citation presence alone cannot establish truth or verify arbitrary prose. Unsupported claims fail closed. |
| D12 | Documentation-only Phase 0 | The user explicitly requests the plan and questions before app code, and an OK between phases. |
| D13 | Canonical invoice identity and unique transfer ownership | An obligation-row lock alone would not prevent duplicate imported obligations. |
| D14 | Dispatch gates on ingress/reducer watermarks | Already-received evidence must invalidate stale approval even while asynchronous reduction is delayed. |
| D15 | Authoritative beneficiary comparison and immutable executable intent | Bind approval to bank details, while disclosing the remaining external mutation race if provider version preconditions are unavailable. |

## Quantum Sentinel directive (added by Claude Code, October 27, 2026)

| ID | Decision | Reason / remaining condition |
| --- | --- | --- |
| D16 | Directive layout (`apps/api`, `apps/web`, `packages/contracts`, `packages/policy`, `packages/airwallex`, `spec/`) plus `packages/db` | Follows AGENTS.md §4. Drizzle migrations are shared by the API, worker, scripts and integration tests, so they get their own package. Worker is a second entry point in `apps/api`, not a separate app. |
| D17 | This repository is the "new separate repository" required by AGENTS.md §3 | It never held Quantum Chartered code. Renaming the folder or remote to `quantum-sentinel` is cosmetic and waits until the founder creates the remote; creating or publishing a remote needs founder approval. |
| D18 | Original brief archived at `docs/hackathon/ORIGINAL_BRIEF.md`; AGENTS.md/CLAUDE.md now hold the Master Build Directive | The directive asks to be saved as both files. The archive keeps Codex's Phase 0 context traceable. |
| D19 | Tiers T0–T5 replace Phases 0–4 | Directive §11. Codex's Phase 0 output is the T0 documentation deliverable. |
| D20 | Single agent write tool `propose_action` (was `propose_replacement`) | Directive §5. One tool can propose REPLACE, ESCALATE or WAIT acknowledgement; policy still gates each. |
| D21 | Keep USD / LOCAL / no-FX first slice; SWIFT out of scope | Avoids the EUR 12.85 per-payout SWIFT fee and FX. The directive's $25,000 amount is illustrative and works on USD LOCAL. |
| D22 | `request_id` is a UUID v4 (36 chars), validated 10–50 chars | Builder guide states the 10–50 limit (error code `018`). |
| D23 | Request amounts serialized as decimal strings; response numbers parsed via their shortest decimal string | Docs examples send `"50"` but return `68.13` as a JSON number. No float arithmetic on money. |
| D24 | Keep Codex's tool pins (pnpm 12.15, TS 6.0, Vitest 5, ESLint 10 + typescript-eslint 8) | They were current and compatible (typescript-eslint supports TS < 6.1). pnpm 10's self-switch to 12 broke on this machine, so pnpm 12 is installed directly. |
| D25 | Hand-written SQL migrations + typed Drizzle mirror + small advisory-locked migrator | Constraints, partial indexes and triggers stay explicit and reviewable; Drizzle is used for typed queries only. |
| D26 | Sentinel Postgres on 127.0.0.1:54329, Compose project `quantum-sentinel`; `createDb` refuses :5432 | Quantum Chartered's Postgres runs on :5432 on the dev machine; directive §3 forbids touching it. |
| D27 | Three retry classes: `read`, `keyed` (request_id, identical bytes), `unkeyed` (never retried; ambiguous => UNCERTAIN) | Directive rule "never retry an uncertain payment as a new transfer"; beneficiary create and simulation calls document no dedup key. |
| D28 | Duplicate request_id is reconciled by lookup and adopted only if amount, currency, request_id (and beneficiary when present) match | A duplicate error proves only that *something* used the id; adopting a mismatched transfer would hide a bug or attack. |
| D29 | Transfer history is a pure fold over append-only observations; status moves forward along the documented graph; unknown statuses are conflicts | Provider timestamps/versions are not a sequence; PAID can fail later; failure facts must survive a bare CANCELLED. |
| D30 | Finality is conservative: CONFIRMED_FAILED needs captured failure facts + FAILED/CANCELLED and no PAID ever seen | Bare CANCELLED and failure-after-PAID escalate rather than permit replacement. |
| D31 | Webhook: accept transfer under `data` or `data.object`; 73 h max age; 401 on bad signature; 200 only after commit | Docs disagree on the envelope; retry window ~3 days with unknown timestamp renewal; event-id dedup is the replay defence. |
| D32 | Deposit `amount` sent as an exact JSON number via `JSON.rawJSON` | The reference types it as a number; this avoids float formatting entirely. |
| D33 | `payments.blocking` is a generated column; one partial unique index enforces one blocking payment per obligation | The fence lives in the database, so no code path (including a bug or a direct SQL insert) can create a second live payment. Only FAILED_CONFIRMED (with failure type) and NOT_SENT release it. |
| D34 | Lock order is always obligation, then incident | Prevents deadlocks between approval, evaluation and execution transactions. |
| D35 | Replacement payments are created only by `approveProposal`; the executor is the only caller of `createTransfer` | One narrow path for money movement; "Resend anyway" only audits and routes to approval. |
| D36 | Executor re-validates provider status, beneficiary hash, balance, approval binding and policy before sending; never holds a DB transaction across HTTP | Directive invariant 5; uncertain outcomes keep the fence and are reconciled by request_id first on retry. |
| D37 | Approval binding uses the incident version at proposal time; executor checks against version-1 while EXECUTING | APPROVE itself bumps the version; any other change in between invalidates the approval. |
| D38 | Evaluation only transitions when material inputs change | Periodic re-evaluation must not churn (and kill) pending approvals. |
| D39 | Failure with no recorded `failure_type` escalates | Invariant 2: a bare "simulation" reason is not proof of what happened. |
| D40 | Ledger posts only provider-proven facts; unbalanced journals rejected by a deferred constraint trigger; reconciliation reports but never repairs | Invariant 11: never invent settlement. |
| D41 | Manual tool-use loop (not the SDK Tool Runner) on the beta Messages API | We need our own step/token/time bounds, a verifier gate on `submit_report`, audited refusal of unknown tools, and a fake model for tests. |
| D42 | Default model `claude-opus-5-5` at effort `medium`; `ANTHROPIC_MODEL` / `ANTHROPIC_EFFORT` override | Directive asks for a cost-efficient, configurable default. Opus 5.5 at medium effort ($4/$20 per MTok) keeps quality; cheaper Sonnet/Haiku is one env var away. Choice of a cheaper model stays with the founder. |
| D43 | Server-side refusal fallback `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) on by default | Recommended for Opus 5.5; a refusal never blocks safety (the deterministic decision stands either way). Disable via config if the account rejects it. |
| D44 | Final report via a strict `submit_report` tool, re-validated with Zod and then the grounding verifier | Forced `tool_choice` is a 400 on Opus 5.5; strict tool + prompt + verifier feedback loop (max 3 attempts) gives schema-valid, grounded output. |
| D45 | The report must recommend exactly what the deterministic policy decided | "Code decides; the LLM explains." Disagreement goes in `uncertainties`; an override is a verifier error. |
| D46 | Supplier text is screened by regex in code before the model sees it, and fenced as untrusted data in tool output | Bank-detail changes must escalate even if the model is fooled (invariant 13). Broad patterns: a false positive costs a review, a false negative could cost a payment. |
| D47 | Evidence IDs are registered per run; citations to anything the model was not shown are rejected | Prevents invented or guessed IDs; makes each run's grounding reproducible (`evidence_shown` stored on `agent_runs`). |
| D48 | Bearer-token users with roles OWNER / APPROVER / OPERATOR / VIEWER; only SHA-256 of tokens stored; console keeps the token in sessionStorage | Light SaaS foundation (directive §10) without building an identity provider; tokens are shown once by `pnpm seed:demo`. |
| D49 | Four-eyes: the proposer of a payment cannot approve it | Bound approvals mean little if the same person proposes and signs. Agent proposals (`agent:<run>`) always need a human. |
| D50 | Scenario Lab MOCK mode with a MockProvider whose state is Sentinel's own observation log; incidents labelled `MOCK_SCENARIO`; Lab events refused on real incidents | Lets the full demo run without keys, honestly labelled; never touches Airwallex; survives restarts. |
| D51 | Mock investigator (`mock-investigator`, zero tokens, zero cost) is used when no Anthropic key is set, and labelled "Mock AI" everywhere | The console and demo work before credentials exist; it drives the same tools and verifier, so the safety path is identical. |
| D52 | Each Lab scenario resets the simulated wallet (audited `lab.wallet_reset`) | Like a sandbox reset; otherwise earlier runs drain the mock balance and later scenarios escalate for funds. |
| D53 | Approve executes immediately in the request; the background worker retries PENDING / expired UNCERTAIN executions | Fast feedback for the approver; crash-safe because the execution is committed before any provider call. |
| D54 | Console: React 19 + Vite 8 + Tailwind 4 + Radix dialog/tooltip, no icon library | Minimal, accessible primitives; lucide-react was dropped rather than bypass pnpm's minimum-release-age policy. |
| D55 | pnpm `allowBuilds` only for esbuild | pnpm 12 blocks dependency build scripts by default; esbuild's postinstall only selects its prebuilt binary. |
| D56 | One image runs the API and serves the built console; Compose adds the `app` service with demo bootstrap | One command, one port (`:4000`), no separate web server; the API already serves `apps/web/dist`. |
| D57 | Demo bootstrap writes role tokens to `.local/demo-tokens.json` (git-ignored, mode 600), never to logs | Directive: never log keys. A fresh clone still gets working sign-in without any manual seeding. |
| D58 | Port guard refuses only `localhost:5432` | The guard protects the other project on the dev machine; inside Compose, Sentinel's Postgres is `postgres:5432`. |
| D59 | Playwright uses the installed Chrome (`channel: "chrome"`) against an isolated `sentinel_e2e` DB and API on `:4100` | No browser download, never touches the developer's demo data; tests run serially because they tell one story. |
| D60 | An attack counts as succeeded only if its unsafe outcome is observed after the attempt; a harness error counts as succeeded | An error message is not proof of safety; failing open in the scoreboard would hide a broken check. |
| D61 | AI attacks use scripted "compromised" models that obey the injected text | A worst case for model obedience. It tests the controls around the model, not a real model's resistance (that needs live runs). |
| D62 | The attack suite also runs inside `pnpm check`; the scoreboard records the commit and flags uncommitted code | A regression that lets any attack through fails CI; the published scoreboard is traceable to exact code. |
| D63 | Replacement allowed only after BENEFICIARY_BANK_RETURNED, CHANNEL_TIMEOUT, SYSTEM_ERROR or INSUFFICIENT_FUNDS; all other failure types escalate | Re-sending to closed, invalid or recalled accounts fails again or pays twice; correcting details is a bank-detail change for a person. Found while writing the eval matrix. |
| D64 | No provider record of the original -> ESCALATE (was WAIT) | Without any provider observation Sentinel cannot tell whether money moved. |
| D65 | A supplier message claiming the money arrived raises EVIDENCE_CONFLICT (per-sentence, negation-aware) | A replacement while the supplier says it was received risks paying twice; a person reconciles. |
| D66 | Eval reports only measured outcomes on this machine, labels the provider and investigator, and has no baseline | Directive: never invent improvement percentages. Live-model numbers come only from `pnpm eval --live`. |
| D67 | TLA+ model checked by TLC 1.7.4 in a container pinned by SHA-256; `pnpm spec` runs a matrix (design, pre-fix design, each defence removed, reachability witnesses) and fails on any unexpected row | One step per DB transaction or provider call, so TLC sees real interleavings; the matrix shows which defences are load-bearing and that the proof is not vacuous. |
| D68 | BLOCKED / REJECTED release the fence (NOT_SENT) only if the execution was claimed once and the payment is still INTENDED/UNCERTAIN; otherwise it stays UNCERTAIN and the incident escalates. A SUCCEEDED execution is never overwritten | Found by TLC: a stale worker (lease expired, still alive) released the fence while a re-claiming worker sent, allowing a second replacement. Fail closed (invariant 12); a later success or lookup settles a held payment. |
| D69 | The arrival and cost estimate is advisory: computed on read from labelled illustrative priors (`priors-illustrative-2026-11-02`), never stored as a decision input, never prices a replacement that policy forbids; no number at all when finality is unknown | Directive §5: confidence is computed in code from labelled priors, never presented as calibrated. Code decides; the estimate only shows when, say, a stuck transfer makes waiting expensive, so a person can escalate. |
| D70 | Agent Activity and Reconciliation are read-only views over stored runs (`GET /api/agent-runs`, `GET /api/reconciliation`); running reconciliation stays an operator action | Should-tier screens (§9) show measured data only; viewers can see but not act. |
