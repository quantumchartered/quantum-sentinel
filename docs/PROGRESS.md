# Progress and handoff

Updated October 27, 2026 by Claude Code. Branch: `t3a/investigator`, stacked on `t2/safety-core`, then `t1/integration`, then `codex/phase-0-plan`. Nothing is merged to `main` yet.

## Current stopping point

**T3a (the Claude investigator) is built and tested with a scripted MOCK model, on top of T2 (safety core) and T1.** Everything is tested against MOCK provider data and a real local Postgres. **Nothing has run against the real Airwallex sandbox or the live Claude API yet.** No Anthropic key has been supplied, and for the sandbox the founder has not created the sandbox account and API key. Claude Code cannot do that step (creating accounts and handling API keys are off-limits for the agent). The founder steps are below.

Ownership note: on Oct 27, Codex briefly wrote scaffold files into this folder at the same time as Claude Code. The founder stopped Codex and gave Claude Code sole ownership. Codex's tool pins (TS 6, Vitest 5, ESLint 10, pnpm 12) and its ESLint `parseFloat` rule were kept.

## Done and tested

| Area | Where | Tests |
| --- | --- | --- |
| Workspace (pnpm 12, strict TS 6 NodeNext, Vitest 5, ESLint 10) | root | `pnpm check` |
| Money: bigint minor units, exact major↔minor conversion | `packages/contracts/src/money.ts` | 31 unit tests incl. fast-check |
| Airwallex adapter: sandbox-only, token refresh, retry classes, duplicate/uncertain reconciliation, Zod decoders | `packages/airwallex/src/*` | 32 tests against a fake server |
| Webhook verification and parsing | `packages/airwallex/src/webhook.ts` | 9 tests |
| Transfer history: append-only failure facts, forward-only status, conservative finality | `packages/policy/src/transfer-history.ts` | 14 tests incl. fast-check |
| **Decision rules** (WAIT / REPLACE / ESCALATE, reason codes) | `packages/policy/src/decide.ts` | in `safety-core.test.ts`, incl. a property test: REPLACE only when every gate passes |
| **Incident state machine** (RESOLVE needs the original's fate) | `packages/policy/src/incident.ts` | property test over random event sequences |
| **Bound approvals** (HMAC over 12 bound fields, 15 min TTL, key versions) | `packages/policy/src/approval.ts` | each bound field mutated → rejected |
| **Audit hash chain** | `packages/policy/src/audit-chain.ts`, `packages/db/src/audit.ts` | edit, delete and reorder detected; property test |
| Event store (append-only, dedup, tenant scoping) | `packages/db` migration 0001 | 11 integration tests |
| **Payment fence** (partial unique index on `blocking`; immutable payments; terminal states stay terminal) | migration 0002 | DB bypass refused; immutability |
| **Incidents, evidence (labelled, trusted flag), decisions, proposals, approvals, executions outbox** | migration 0002, `packages/db/src/{incidents,execution}.ts` | 19 tests in `safety.int.test.ts` |
| **Executor**: lease claim, reconcile uncertain attempts by request_id, full revalidation, no transaction across HTTP | `packages/db/src/execution.ts` | 10 racing workers → 1 provider call (mutation-checked) |
| **Ledger** (double entry; unbalanced journal rejected at commit; idempotent postings) and **reconciliation** | migration 0003, `packages/db/src/ledger.ts` | Scenario A books balance; SYNTHETIC mismatch flagged |
| Fastify webhook receiver and backup poller | `apps/api/src/{server,poller,main}.ts` | 8 integration tests |
| **Supplier-text screening** in code (bank-detail change, prompt injection) and untrusted-evidence intake | `packages/policy/src/text-signals.ts`, `ingestSupplierMessage` | 16 unit tests |
| **Claude investigator**: bounded manual tool loop, read-only strict tools, `propose_action` (proposal only), strict `submit_report` | `apps/api/src/agent/{loop,tools,model,prompt,report}.ts` | 11 integration tests with a MOCK model |
| **Grounding verifier** (citations, labels, checkable facts, stale status, policy agreement, contradictions) and **revision diff** | `apps/api/src/agent/{verifier,diff}.ts` | 11 unit tests; override guard mutation-checked |
| `agent_runs` metering (tokens, cost in micro-USD, tool calls, evidence shown, verification) | migration 0004 | covered by agent tests |
| CLIs: `pnpm sandbox …`, `pnpm audit:verify`, `pnpm reconcile`, `pnpm investigate` | `apps/api/src/cli/*` | audit:verify and reconcile runtime-checked (tamper detected). **Sandbox CLI not yet run** |

Covered scenarios (MOCK provider, real Postgres):
- **A:** SENT → WAIT, and "Resend anyway" is blocked and audited. Then FAILED (bank return) followed by a bare CANCELLED → REPLACE → proposal → bound approval → executor → replacement PAID → RESOLVED with the original's fate recorded → books balance.
- **B:** 20 concurrent approvals → 1. 10 racing executors → 1 provider call. Blocked cases: stale evidence, the original turning PAID after approval, a beneficiary bank change, an expired approval. A timeout after create is reconciled to the same transfer.
- **C:** a supplier email asking to pay a new account plus prompt injection → ESCALATE, and no proposal is possible. A SYNTHETIC unmatched transfer or over-payment is flagged by reconciliation and not repaired.
- A fast-check property over concurrent interleavings with injected provider failures shows at most one replacement transfer ever reaches the provider.

Commands:
- `pnpm check`: lint, typecheck, 147 unit tests, 49 Postgres integration tests (Docker required). Last run: all passing.
- `pnpm test`: unit tests only.

## Founder steps (only you can do these)

1. Create a sandbox account at sandbox.airwallex.com. Create an API key under Account → Developer → API keys.
2. In PowerShell, in the project folder: `Copy-Item .env.example .env`. Put the Client ID and key in `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY`. Don't paste them into chat.
3. Add a long random `APPROVAL_HMAC_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. Tell Claude Code "keys are in .env". Claude then runs `pnpm sandbox seed-org`, `fund`, `beneficiary`, `transfer`, and the transitions (PLAN.md §0.4) and commits the fixtures.
5. Later, when webhooks are needed: run a tunnel (`cloudflared tunnel --url http://127.0.0.1:4000`). Register `<tunnel>/webhooks/airwallex` under Settings → Developer → Webhooks in the sandbox web app, and put the secret in `AIRWALLEX_WEBHOOK_SECRET`.

## Next steps for the agent

1. With keys: run the sandbox feasibility sequence. Wire `airwallexExecutionProvider` into a sandbox Scenario A run.
2. With an Anthropic key (ANTHROPIC_API_KEY in `.env`, or `ant auth login`): `pnpm investigate <incidentId>` on a local incident. Tune the prompt only if the verifier rejects real reports.
3. Without keys: the HTTP API for the console (incidents, evidence, decisions, agent runs and diffs, proposals, approvals, audit), then T3b, the web console (Incident Workspace, Decision Replay, Approval Center, Scenario Lab).

## Known gaps and shortcuts

- **No sandbox contract evidence yet.** Decoders follow the official reference and fail closed.
- `getBeneficiary` returns raw JSON. The beneficiary hash uses `beneficiary.bank_details` (unconfirmed shape); if it is absent, execution is blocked.
- The executor uses `transferMethod: "LOCAL"`, `reason: "goods_purchased"`, and source currency = payment currency. Fees are not posted to the ledger yet.
- Resolution uses PAID as "settled" for the sandbox demo, although Airwallex documents that PAID can still fail. A late failure after resolution needs a REOPEN path, which is not wired yet.
- Only one tenant is wired into the API. Users, roles and per-tenant secrets come with the console API.
- The audit chain detects edits, deletions and reordering. On its own it does not detect truncation of the newest entries, or a privileged rewrite of the whole chain. Exported checkpoints are planned (T5 security notes).
- `docker compose up` runs only Postgres today.
- The investigator has only been exercised with a scripted MOCK model. Real-model behaviour (citation discipline, verifier pass rate, cost per run) is unmeasured.
- Supplier-text screening is pattern-based. It is broad on purpose, but it can be evaded by paraphrase, so the beneficiary-hash check at execution remains the hard stop.
- No prompt caching yet. The system prompt and tools are stable, so adding `cache_control` is a cheap later win.

## Blocked on the founder

1. Sandbox account and API key (steps above).
2. Anthropic API key or hackathon Claude credits. T3a code is done; live runs need this.
3. Answers to [OFFICIAL_REQUIREMENTS.md §5](hackathon/OFFICIAL_REQUIREMENTS.md).
4. Quantum Chartered patterns to disclose ([PRIOR_WORK.md](../PRIOR_WORK.md)).

## Next agent's first steps

1. Read AGENTS.md, this file, PLAN.md §0, OFFICIAL_REQUIREMENTS.md and DECISIONS.md.
2. Run `pnpm install && pnpm check`. It must be green before you change anything.
3. Pick up "Next steps for the agent".
