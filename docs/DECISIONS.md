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
