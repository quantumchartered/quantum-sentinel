# Progress and handoff

Updated October 27, 2026 by Claude Code. Branch: `t1/integration` (branched from `codex/phase-0-plan`; neither is merged to `main` yet).

## Current stopping point

**Tier T1 (Integration proof).** Everything that can be built without credentials is done and tested. **Nothing has run against the real Airwallex sandbox yet**, because the founder has not supplied API keys. The next step is the [PLAN.md §0.4](PLAN.md) feasibility run using `pnpm sandbox …` (see the README command table).

Ownership note: on Oct 27, Codex briefly wrote scaffold files into this folder at the same time as Claude Code. The founder stopped Codex and gave Claude Code sole ownership. Codex's tool pins (TS 6, Vitest 5, ESLint 10, pnpm 12) were kept, and so was its ESLint `parseFloat` rule.

## Done and tested

| Area | Where | Tests |
| --- | --- | --- |
| Workspace (pnpm 12, strict TS 6 NodeNext, Vitest 5, ESLint 10) | root | `pnpm check` |
| Money: bigint minor units, currency allowlist, exact major↔minor conversion; rejects floats, exponents and excess precision | `packages/contracts/src/money.ts` | 31 unit tests incl. fast-check |
| Airwallex adapter: sandbox-only guard, single-flight token refresh, three retry classes, duplicate/uncertain reconciliation by `request_id`, Zod decoders, failure normalization (current + legacy) | `packages/airwallex/src/{http,client,schemas,errors}.ts` | 32 tests against a scripted fake server |
| Simulation behind one interface (transition, deposit) with documented enums | `packages/airwallex/src/simulation.ts` | covered above |
| Webhook signature verification (raw bytes, constant time) and envelope parsing (`data` or `data.object`) | `packages/airwallex/src/webhook.ts` | 9 tests |
| Transfer history: append-only failure facts, forward-only status, conservative finality | `packages/policy/src/transfer-history.ts` | 14 tests incl. 3 fast-check properties |
| Postgres event store: append-only triggers, dedup by event id, tenant scoping, request_id uniqueness | `packages/db` (`migrations/0001_t1_event_store.sql`) | 11 integration tests |
| Fastify webhook receiver (200 only after commit, 401 on a bad signature, 256 KB limit) and backup poller | `apps/api/src/{server,poller,main}.ts` | 8 integration tests |
| Sandbox CLI with redacted fixtures | `apps/api/src/cli/sandbox.ts` | redaction: 2 tests. **CLI not yet run against the sandbox** |

Commands:
- `pnpm check`: lint, typecheck, 88 unit tests, 19 integration tests (Docker required). Last run: all passing.
- `pnpm test`: unit tests only (no Docker).

The "FAILED flips to CANCELLED in seconds" requirement is covered at three levels: pure fold (`transfer-history.test.ts`), persisted (`event-store.int.test.ts`), and HTTP webhook plus poller (`server.int.test.ts`). Each covers both delivery orders.

## Half-done and next steps

1. **Founder:** put `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` in `.env`. Then `pnpm sandbox seed-org`, which prints a `SENTINEL_ORGANIZATION_ID` to add.
2. Run §0.4 in order: `check` → `fund` → `beneficiary` → `transfer` → `transition SENT` → `watch` + `transition FAILED --failure-type BENEFICIARY_BANK_RETURNED` → second transfer to `PAID` → repeat-request_id check. Commit the fixtures from `fixtures/sandbox/` and add a "Verified in sandbox" table to API-RESEARCH.md.
3. Tunnel: `cloudflared tunnel --url http://127.0.0.1:4000`. Founder then registers `<tunnel>/webhooks/airwallex` in the sandbox web app (Settings > Developer > Webhooks) and puts the secret in `AIRWALLEX_WEBHOOK_SECRET`.
4. Then T2 (PLAN.md §0.5): obligations/payments tables with the partial unique index, incident state machine, bound approvals, outbox executor, audit chain, ledger.

## Known gaps and shortcuts

- **No sandbox contract evidence yet.** Decoders follow the official reference (Docs MCP). The real responses may differ. The decoders fail closed (`AirwallexContractError`), so a mismatch will show up loudly.
- `createBeneficiary` returns the raw JSON. Its response shape gets pinned after the first fixture.
- Beneficiary payload: the CLI checks every schema-required path before sending. `company_name` for COMPANY is included but not yet confirmed by a schema response.
- The webhook max age defaults to 73 h because Airwallex retries for about 3 days and the docs don't say whether `x-timestamp` is renewed. Event-id dedup is the replay defence. Tighten this after observing sandbox redelivery.
- Only one tenant is wired into the API (`SENTINEL_ORGANIZATION_ID`). Per-tenant webhook secrets wait for `provider_connections` in T2.
- `docker compose up` runs only Postgres today.

## Blocked on the founder

1. Sandbox API keys in `.env` (see SETUP.md). Do not paste them into chat.
2. Developer MCP login: `/mcp` → authenticate `airwallex-dev`.
3. Anthropic API key or the hackathon Claude credits (needed from T3a).
4. Answers to [OFFICIAL_REQUIREMENTS.md §5](hackathon/OFFICIAL_REQUIREMENTS.md).
5. Quantum Chartered patterns to disclose ([PRIOR_WORK.md](../PRIOR_WORK.md)).

## Next agent's first steps

1. Read AGENTS.md, this file, PLAN.md §0, OFFICIAL_REQUIREMENTS.md and DECISIONS.md.
2. Run `pnpm install && pnpm check`. It must be green before you change anything.
3. If `.env` has keys, do "Half-done and next steps" 2–3. Otherwise start T2 items that need no keys.
