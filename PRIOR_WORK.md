# Prior work and provenance

Recorded October 27, 2026, during Phase 0.

## Before this session

- The repository contained only Git metadata, had no commits, and contained no application source files when inspected.
- The user supplied the project concept, architecture, stack, safety requirements, demo scenarios, and workflow in a pasted instruction file, plus an earlier build prompt. These requirements are not claimed as new agent-authored work.
- The pasted instruction file is preserved byte-for-byte as AGENTS.md and CLAUDE.md.
- No Quantum Chartered source code, library, or prior implementation was imported. Prior Quantum Chartered patterns have not yet been identified by the user; absence of code in this checkout does not establish that the ideas are original.

## Created during the hackathon session

- Phase 0 plan, API/webhook research notes, decisions, setup documentation, progress record, README, environment template, ignore rules, and a portable Claude MCP configuration.
- Codex Airwallex Docs and Developer MCP entries registered locally. Docs endpoint verified; Developer account access remains subject to OAuth verification.
- No application code, tests, formal model, or paid service usage implemented.

## Claude Code session (October 27, 2026)

- Replaced AGENTS.md/CLAUDE.md with the founder-supplied Quantum Sentinel Master Build Directive (user-authored requirements, not agent work) and archived the original brief under docs/hackathon/.
- Wrote docs/hackathon/OFFICIAL_REQUIREMENTS.md, PLAN.md §0, DECISIONS D16–D23 and the rewritten README.
- Still no application code. No Quantum Chartered code has been read or copied. The directive (§3) lists Quantum Chartered patterns we *may* re-implement: integer money, double-entry ledger, idempotency registry, SERIALIZABLE transactions, ordered row locking, provider adapter, event queue and redaction. Any of them that we use will be listed here as a "pre-existing pattern, re-implemented during the hackathon".

## Claude Code T1 (October 27, 2026), all written during the hackathon

- packages/contracts (money), packages/airwallex (adapter, simulation, webhooks), packages/policy (transfer history), packages/db (schema, migrations, event store), apps/api (webhook receiver, poller, sandbox CLI) and their tests.
- Codex wrote the initial workspace config (package.json pins, tsconfig.base.json, eslint.config.js) during the hackathon on Oct 27. Claude Code reconciled it and kept it.
- No Quantum Chartered code was read or copied. The patterns used (integer minor units, idempotency keys, append-only evidence, advisory-locked migrations) are standard and were written fresh here. If the founder confirms they mirror specific Quantum Chartered designs, list them as "pre-existing pattern, re-implemented".

## Required follow-up

Before importing prior work, record its source repository/path, author, license, original date, reused parts, and changes made during the hackathon. Add externally reused code and assets to this record. Do not represent templates, prior patterns, generated results, or unrun evaluations as new measured results.
