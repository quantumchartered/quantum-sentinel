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
