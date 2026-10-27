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
