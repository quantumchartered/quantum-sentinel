# Progress and handoff

Updated October 27, 2026. Branch: `codex/phase-0-plan`.

## Current stopping point

**Phase 0 — plan ready for review. App implementation has not started.** Documentation checks passed; this checkpoint is committed on the Phase 0 branch. Developer MCP login remains incomplete as described below. Stop before Phase 1 until the user explicitly approves it.

The user delegated the first-demo scope choice: use USD/LOCAL/no-FX and escalate late failures after PAID. This did not approve starting implementation.

## Completed

- Inspected the initially empty repository with no commits; copied the full pasted request identically into AGENTS.md and CLAUDE.md.
- Read the builder guide, API introduction, current transfer/version/simulation/beneficiary reference, and official webhook/auth/balance documentation. Documented conflicting fields, routes, and response examples rather than guessing.
- Wrote PLAN.md with provider and incident state machines, transaction/outbox design, canonical obligation identity, ingress/reducer dispatch gate, bound approvals, data model, typed tools, test/formal strategy, risks, and open questions.
- Added README, decisions, provenance, setup instructions, `.env.example`, `.gitignore`, and Claude project MCP entries. No actual secrets or `.env` created.
- Registered both requested Codex MCP servers. Public Docs MCP initialization/tool listing/search succeeded and its namespace became available. Developer OAuth timed out; authenticated account reads remain undone.
- Confirmed Node/npm, Docker Compose, and Docker engine availability. Claude and Java were not found on PATH.
- Independent review caught duplicate-import, delayed-reducer, and beneficiary-drift risks; the plan now addresses them.

## Checks and results

- `Get-FileHash AGENTS.md, CLAUDE.md -Algorithm SHA256`: identical; also matched the pasted source.
- `codex mcp get airwallex_docs` / `codex mcp get airwallex_dev`: configured at the requested sandbox URLs.
- Docs MCP protocol initialize, `tools/list`, and documentation search: succeeded; no account data used.
- `node --version`, `npm --version`, `docker compose version`, `docker info --format '{{.ServerVersion}}'`: succeeded. Docker required execution outside the restricted shell sandbox; no daemon change was made.
- Documentation validation: all 15 local Markdown links across 10 files resolve; instruction copies match the supplied source; secret placeholders are empty; `.env`, `.env.local`, and `.env.production` are ignored; `.env.example` is trackable; MCP URLs match; no application code is present. Ran a fail-fast PowerShell assertion batch covering these conditions (exit 0).
- Authored-file whitespace check: `git diff --cached --check -- . ':(exclude)AGENTS.md' ':(exclude)CLAUDE.md'`. The copied user instructions intentionally preserve three source lines with trailing spaces; their byte equality is checked separately. `.gitattributes` preserves their original bytes through Git checkout. All authored-file whitespace issues found in the first pass were corrected before commit.
- **Application tests: not run; no application/test runner exists. No safety score, model-check result, or end-to-end success is claimed.**

## Half-done / external requirements

- Developer MCP is configured, not authenticated. Restart `codex mcp login airwallex_dev`, complete sandbox sign-in, then verify list Global Accounts. No OAuth process remains running after the recorded timeout.
- Claude configuration is prepared but cannot be exercised without Claude Code.
- API pin `2026-08-21` is a documented candidate; account and webhook schemas still need sandbox contract checks.
- Finality/refund/arrival evidence contract and prior Quantum Chartered work need the user's input. See PLAN.md section 12.

## Known limitations and TODOs

- No source code, migrations, Compose file, UI, LLM calls, test suite, formal model, GIF, video script, or EVAL.md yet. README deliberately does not advertise a working launch command.
- Current official docs and guide differ on beneficiary schema route, failure object, duplicate error spelling, login success status, and deposit behavior. Do not copy old payloads without validation.
- Not all mutating endpoints document provider idempotency keys; the plan specifies local operation tracking and no blind retries for uncertain unkeyed mutations.
- The absolute real-world duplicate-payment guarantee depends on external finality and no out-of-band transfers. Synthetic evidence must be visibly labeled; human approval cannot override unknown finality.
- Prior-work disclosure remains pending owner references; no pre-existing code was imported.

## Next agent's first steps

1. Read AGENTS.md/CLAUDE.md, this file, PLAN.md, DECISIONS.md, API-RESEARCH.md, and WEBHOOK-RESEARCH.md.
2. Check whether the user has approved Phase 1 in the conversation. If not, present the plan/questions and wait; do not infer approval from scope delegation.
3. Finish sandbox authentication and credential setup as documented, then verify read-only contracts and resolve documented uncertainties before dependent code or mutations.
4. Implement Phase 1 in small tested steps, updating this file and accurate README commands after each completed step. Use a `wip/<task>` branch only if forced to stop with unfinished implementation; Phase 0 is a documentation checkpoint, not broken application code.

See [DECISIONS.md](DECISIONS.md) for rationale and [PRIOR_WORK.md](../PRIOR_WORK.md) for attribution.
