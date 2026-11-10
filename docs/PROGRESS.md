# Progress and handoff

Updated November 2, 2026 by Claude Code (T4 complete). Branch: `t4/attacks`, stacked on `t3b/console`, `t3a/investigator`, `t2/safety-core`, `t1/integration` and `codex/phase-0-plan`. Nothing is merged to `main` yet.

## Current stopping point

**T3b (HTTP API and operator console) is built, on top of T3a (investigator), T2 (safety core) and T1.** Scenarios A, B and C run end to end in the console in MOCK mode: a simulated provider and the labelled Mock AI. This was verified in a real browser. Everything is tested against MOCK provider data and a real local Postgres. **Update Nov 10: Scenario A ran end to end on the real Airwallex sandbox** with a scoped sandbox key the founder created ([SANDBOX-RUN.md](SANDBOX-RUN.md)). The live Claude API has still not been used (no Anthropic key).

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
| **Users and roles** (token hashes only), **four-eyes** approvals, incident **origin** labels | migration 0005, `packages/db/src/users.ts` | four-eyes test + API tests |
| **HTTP API** (overview, incidents, replay, approvals, audit, actions, Lab) with role checks and tenant scoping | `apps/api/src/http/api.ts` | 11 API integration tests (auth, roles, Scenario A/B/C, four-eyes, reject, tenant isolation) |
| **Scenario Lab** MOCK mode (MockProvider on the observation log, scenarios, events, race) and **Mock AI** | `apps/api/src/lab/*`, `apps/api/src/agent/mock-investigator.ts` | covered by API tests |
| **Operator console**: Overview, Incidents, Incident Workspace, Decision Replay, Approval Center, Scenario Lab, Audit log | `apps/web` | Browser-verified (see below). No automated UI tests yet |
| **One-command stack**: Dockerfile + Compose `app` service (API serves the built console on `:4000`), demo bootstrap writing tokens to `.local/demo-tokens.json` | `Dockerfile`, `docker-compose.yml`, `apps/api/src/bootstrap.ts` | Verified: `docker compose up --build` serves the console, deep links, 401 unauthenticated; fresh-tenant bootstrap gives 4 working role tokens |
| **Playwright browser suite** (system Chrome, isolated `sentinel_e2e` DB, API on `:4100`) | `e2e/` | 11 tests, passed twice in a row; screenshots in `docs/screenshots/` |
| **Adversarial attack suite** (33 attacks, outcome-checked) and scoreboard | `apps/api/src/attacks/`, `docs/ATTACKS.md` | 33 run / 0 succeeded; also inside `pnpm check` (35 tests); mutation-checked (four-eyes disabled -> TEN-05 succeeds) |
| **Evaluation matrix** (24 cases, every §12 case type) | `apps/api/src/eval/`, `EVAL.md` | 24/24 pass; inside `pnpm check`; mutation-checked (ACCOUNT_CLOSED made replaceable -> E07 fails) |
| **Policy tightening** (policy-2026-11-02.1): replaceable failure types only, missing provider record escalates, supplier receipt claims raise EVIDENCE_CONFLICT | `packages/policy/src/{decide,text-signals}.ts` | 22 unit tests |
| **TLA+ model** of no double payment, checked by TLC (16-row matrix: design, pre-fix design, each defence removed, reachability witnesses) | `spec/`, `spec/RESULTS.md` | `pnpm spec`: design holds up to 3 workers / 3 replacements / 4 claims (1.4M states). Found a real race (stale worker released the fence while another sent); fixed in `execution.ts` (`releaseOrHold`, D68) and replayed in 4 integration tests that fail on the old rule |
| **Arrival and cost estimate** (advisory, labelled illustrative priors; never feeds `decide()`, never prices a forbidden replacement) | `packages/policy/src/estimate.ts`, `GET /api/incidents/:id` (`estimate`), Incident Workspace card | 14 unit tests incl. fast-check; API and browser assertions on Scenario A |
| **Should-tier screens**: Agent Activity (runs, tool calls, verifier, tokens, cost) and Reconciliation (run, findings, ledger, provider transfers) | `apps/web/src/pages/{AgentActivity,Reconciliation}.tsx`, `GET /api/agent-runs`, `GET /api/reconciliation` | API test (roles, tenant isolation); 2 Playwright tests + 375px check |
| **Reopen after resolution**: a late failure of the settling payment, a PAID on the replaced one, or a history conflict reopens and escalates; ledger books the return; worker tick + every reconciliation; Lab event "Paid replacement returned later" | `recheckResolvedIncident(s)` in `packages/db/src/execution.ts`, `ledger.ts` (`paidReversed`), `apps/api/src/main.ts` | 2 API tests (mutation-checked), 1 Playwright test |
| **Clean-install rehearsal** (Nov 2): fresh clone → `pnpm install --frozen-lockfile` → lint, typecheck, 183 unit tests → `docker compose up --build` on an empty database → Scenario A resolved, reconciliation OK, audit verified | — | Manual run, recorded here |
| **SECURITY_AND_LIMITATIONS.md** and the as-built architecture diagram (README) | root | Doc; every claim points at code or a test |
| CLIs: `pnpm sandbox …`, `pnpm audit:verify`, `pnpm reconcile`, `pnpm investigate`, `pnpm seed:demo` | `apps/api/src/cli/*` | audit:verify and reconcile runtime-checked (tamper detected). **Sandbox CLI run against the real sandbox on Nov 10** (check, fund, beneficiary, transfer, transition, watch, scenario-a) |
| **Sandbox Scenario A runner** and **failure classification by documented code** (D72, D73) | `apps/api/src/cli/sandbox-scenario.ts`, `failureCause` in `packages/policy/src/decide.ts` | Real sandbox run (SANDBOX-RUN.md); 4 unit tests |

Covered scenarios (MOCK provider, real Postgres):
- **A:** SENT → WAIT, and "Resend anyway" is blocked and audited. Then FAILED (bank return) followed by a bare CANCELLED → REPLACE → proposal → bound approval → executor → replacement PAID → RESOLVED with the original's fate recorded → books balance.
- **B:** 20 concurrent approvals → 1. 10 racing executors → 1 provider call. Blocked cases: stale evidence, the original turning PAID after approval, a beneficiary bank change, an expired approval. A timeout after create is reconciled to the same transfer.
- **C:** a supplier email asking to pay a new account plus prompt injection → ESCALATE, and no proposal is possible. A SYNTHETIC unmatched transfer or over-payment is flagged by reconciliation and not repaired.
- A fast-check property over concurrent interleavings with injected provider failures shows at most one replacement transfer ever reaches the provider.

Commands:
- `pnpm check`: lint, typecheck (API + web), 187 unit tests, 129 Postgres integration tests (incl. the attack suite and the eval matrix) (Docker required). Last run: all passing.
- Console run: see README "Run the console". The preview launch config is in `.claude/launch.json` (`api`, `web`).

Browser check (Oct 27, built-in browser pane, MOCK mode):
- Scenario A was run as operator, then approver. The steps: WAIT; investigator verified; "Resend anyway" blocked with reasons; bank return injected; REPLACE; the investigator proposes; approved and sent; replacement PAID; RESOLVED. The books balanced and the audit chain verified (29 entries).
- Scenario C escalated, with the risk-flag block shown.
- Decision Replay stepped to the WAIT → REPLACE change.
- Also checked: the not-found error state, the empty approval queue, and no horizontal overflow on 8 pages at 375px.
- Two UX bugs were found and fixed during the check: stale action results after a decision change, and approval outcomes disappearing.
- `pnpm test`: unit tests only.
- `pnpm test:e2e`: 14 Playwright browser tests (needs Docker and Google Chrome). Last run: all passing.
- `docker compose up --build` (or `pnpm up`): the whole app on http://localhost:4000.

## Submission kit (Nov 10)

- Video script: [hackathon/VIDEO_SCRIPT.md](hackathon/VIDEO_SCRIPT.md). Submission text: [hackathon/SUBMISSION.md](hackathon/SUBMISSION.md).
- Console sign-in for the sandbox tenant: `pnpm seed:demo --to-file` rotates the demo users' tokens into `.local/demo-tokens.json` (git-ignored, never printed).
- Sandbox screenshots: `node e2e/sandbox-shots.mjs <incidentId>` with the API on :4000.
- Local branch `main` points at the finished work; nothing is pushed (no remote yet).

## Founder steps (only you can do these)

1. Create a sandbox account at sandbox.airwallex.com. Create an API key under Account → Developer → API keys.
2. In PowerShell, in the project folder: `Copy-Item .env.example .env`. Put the Client ID and key in `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY`. Don't paste them into chat.
3. Add a long random `APPROVAL_HMAC_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. Tell Claude Code "keys are in .env". Claude then runs `pnpm sandbox seed-org`, `fund`, `beneficiary`, `transfer`, and the transitions (PLAN.md §0.4) and commits the fixtures.
5. Later, when webhooks are needed: run a tunnel (`cloudflared tunnel --url http://127.0.0.1:4000`). Register `<tunnel>/webhooks/airwallex` under Settings → Developer → Webhooks in the sandbox web app, and put the secret in `AIRWALLEX_WEBHOOK_SECRET`.

## Next steps for the agent

1. With keys: run the sandbox feasibility sequence. Wire `airwallexExecutionProvider` into a sandbox Scenario A run.
2. With an Anthropic key (ANTHROPIC_API_KEY in `.env`, or `ant auth login`): `pnpm investigate <incidentId>` on a local incident. Tune the prompt only if the verifier rejects real reports.
3. Without keys: T4 is done (attacks, eval, TLA+, estimate, Should-tier screens). T5 remains: posting fees to the ledger and the demo recording (founder). The REOPEN path and the clean-install rehearsal are done. The Could-tier screens (Analytics, Organization Settings) are optional.

## Known gaps and shortcuts

- **Sandbox contract evidence exists for auth, balances, global accounts, deposit, beneficiary schema/create, transfer create/get and simulation** (fixtures/sandbox, SANDBOX-RUN.md). Webhooks and duplicate request_id are not yet verified.
- `getBeneficiary` returns raw JSON. The beneficiary hash uses `beneficiary.bank_details` (unconfirmed shape); if it is absent, execution is blocked.
- The executor uses `transferMethod: "LOCAL"`, `reason: "goods_purchased"`, and source currency = payment currency. Fees are not posted to the ledger yet.
- Resolution uses PAID as "settled", although Airwallex documents that PAID can still fail. Resolved incidents are re-checked and reopen + escalate on a late failure (D71); detection waits for the webhook or the next poll.
- Webhooks and the backup poller are wired to one tenant (`SENTINEL_ORGANIZATION_ID`). The API itself is tenant-scoped by user. Per-tenant provider connections and webhook secrets are not built.
- Scenario Lab SANDBOX mode is not built (needs keys). In the UI it shows as "needs keys".
- The MockProvider keeps the simulated wallet in memory. It resets per scenario and on API restart.
- The audit chain detects edits, deletions and reordering. On its own it does not detect truncation of the newest entries, or a privileged rewrite of the whole chain. Exported checkpoints are planned (T5 security notes).
- The Docker image runs TypeScript through `tsx` (no compile step). Fine for a local demo; not tuned for production.
- Playwright needs Google Chrome installed (it uses `channel: "chrome"`). On a machine without Chrome, run `npx playwright install chromium` and drop the channel.
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
