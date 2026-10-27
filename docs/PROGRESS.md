# Progress and handoff

Updated October 27, 2026 by Claude Code. Branch: `codex/phase-0-plan`.

## Current stopping point

**Tier T0 (Feasibility): documentation done; the credential-dependent steps are blocked on the founder.** No application code exists yet. The next step is the feasibility run in [PLAN.md §0.4](PLAN.md). Start it as soon as `.env` has the sandbox keys.

## Done in this tier

Codex (Phase 0, commit `5b66c86`):
- Plan with the provider and incident state machines, data model, tools and risks ([PLAN.md](PLAN.md) §1–§12).
- Research files [API-RESEARCH.md](API-RESEARCH.md) and [WEBHOOK-RESEARCH.md](WEBHOOK-RESEARCH.md), plus [SETUP.md](SETUP.md), [DECISIONS.md](DECISIONS.md) D01–D15, `.env.example` and `.mcp.json`.

Claude Code (this commit):
- The founder issued the **Quantum Sentinel Master Build Directive**. It is now `AGENTS.md` = `CLAUDE.md` (byte-identical). The original brief is archived at [hackathon/ORIGINAL_BRIEF.md](hackathon/ORIGINAL_BRIEF.md).
- Wrote [hackathon/OFFICIAL_REQUIREMENTS.md](hackathon/OFFICIAL_REQUIREMENTS.md): confirmed rules with their sources, builder-guide guidance, Airwallex facts, 9 discrepancies and 5 unknowns.
- Re-checked airwallexdev.com, `/guide` and the Docs MCP. New facts: `request_id` must be 10–50 characters (code `018`); sandbox SWIFT payouts cost a flat EUR 12.85; webhooks are configured only in the web app; the full 32-value `failure_type` enum for simulation is confirmed; the schema route is `/api/v1/beneficiary_api_schemas/generate`; response amounts are JSON numbers.
- Added PLAN.md §0: the directive delta, the target layout and diagram, how each of the 13 policy invariants will be enforced and tested, the 10-step sandbox feasibility sequence, and the T0–T2 backlog.
- Added DECISIONS D16–D23. Rewrote the README for Quantum Sentinel.

## Checks

- `cmp AGENTS.md CLAUDE.md` → identical.
- `git check-ignore .env` → ignored; `.env.example` has empty secret values.
- Relative Markdown links in `docs/`, `README.md` and `PRIOR_WORK.md` resolve (link check in the commit for this step).
- **Application tests: none exist yet. Nothing has been run against the sandbox.**

## Blocked on the founder

1. Sandbox account and API key: put `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` in `.env` ([SETUP.md](SETUP.md)).
2. Developer MCP login: run `/mcp` in Claude Code and authenticate `airwallex-dev`.
3. Anthropic API key or the hackathon Claude credits (needed in T3a, not before).
4. Tunnel choice: cloudflared (preferred, no account needed for quick tunnels) or ngrok.
5. Answers to the unknowns in [OFFICIAL_REQUIREMENTS.md §5](hackathon/OFFICIAL_REQUIREMENTS.md).
6. Quantum Chartered patterns to disclose or re-implement ([PRIOR_WORK.md](../PRIOR_WORK.md)).

## Local tooling

Node v24.20.0 and corepack 0.35.0 are installed; `pnpm` is not on PATH (enable it with `corepack enable pnpm` in T1). Docker 29.7.2 is installed. Java is missing, so TLC will run in a container in T4.

## Known limitations

- The real-world no-double-pay guarantee depends on finality evidence from the provider (see PLAN.md §5). Simulated evidence will be labelled as simulated.
- The guide and the official docs disagree in places (OFFICIAL_REQUIREMENTS §4). Sandbox fixtures will settle these in T0/T1.

## Next agent's first steps

1. Read AGENTS.md, this file, PLAN.md §0, then OFFICIAL_REQUIREMENTS.md.
2. If `.env` has keys: run the PLAN.md §0.4 steps one at a time. Save redacted fixtures and add the "Verified in sandbox" table to API-RESEARCH.md.
3. Then begin T1 per the PLAN.md §0.5 backlog. One commit per finished step.
