Setup for the coding agent: save this whole file as AGENTS.md in the project root (Codex reads it automatically) and copy it to CLAUDE.md as well, so a later Claude Code session gets the same rules. Connect the Airwallex Docs and Developer MCP servers using the Codex/Claude snippets on [https://airwallexdev.com](https://airwallexdev.com).
You are the lead engineer for our team's entry in the Airwallex Agentic Banking Hackathon (HackerEarth). We were shortlisted for Starter Kit 3: Payment Ops Incident Commander. Build it with me, step by step, in this repository.
- Build phase: Oct 27 – Nov 13, 2026 (submission deadline). Finalists Nov 15, Demo Day Nov 19 (remote OK).
- Submission = working demo + video under 5 minutes + repo link with setup instructions.
- Sandbox only. Test accounts and simulated funds. No real money ever.
- Official resources (read before coding, do not guess): 
  - Builder guide: [https://airwallexdev.com/guide](https://airwallexdev.com/guide)
  - API docs: [https://www.airwallex.com/docs/api/introduction](https://www.airwallex.com/docs/api/introduction)
  - Airwallex Docs MCP (exact field names) and Developer MCP (sandbox calls). Setup snippets are on [https://airwallexdev.com](https://airwallexdev.com). Help: [devhelp@airwallex.com](mailto:devhelp@airwallex.com)
- What the guide says a strong build shows: the agent chooses differently when balance, deadline, evidence or risk changes; amounts, limits, validation, duplicate protection and state transitions live in code; the model reads text, compares evidence and explains; typed tools, not raw credentials; approvals bound to amount, currency, counterparty and evidence; ends in a financial action or an escalation to a person.
Our company sent a supplier transfer through Airwallex days ago. The supplier says the deadline passed and nothing arrived. Nobody knows if it will still clear. The agent investigates and recommends WAIT, REPLACE, or ESCALATE. A human approves. Code guarantees we can never pay twice.
Kit endpoints: POST /beneficiaries/schema, POST /beneficiaries/create, POST /transfers/create, POST /simulation/transfers/{id}/transition, GET /transfers (plus balances and webhooks as needed; confirm via Docs MCP).
Airwallex gotchas from the guide (must handle):
- A failed transfer shows CANCELLED, which does not mean a person cancelled it. Use the failure_type (for example bank return or recall).
- Simulate SENT before PAID; a failure_type only applies after SENT.
- Prefer a FAILED transition with a failure type over a bare cancel (bare cancel gives only failure_reason: "simulation").
- Original and replacement need different request_ids, even with the same beneficiary and amount.
- Check balance before replacing (replacement can fail on insufficient funds). Budget two SWIFT fees if both use SWIFT.
- Never close an incident just because the replacement is PAID. Also record the fate of the original.
Sandbox setup facts from [https://airwallexdev.com](https://airwallexdev.com) (verify before relying on them):
- Sandbox signup at sandbox.airwallex.com. API keys under Account > Developer > API keys. If adding a business, its entity name must be "Sandbox Business" or "New Business Sandbox", or it stays "In review".
- MCP servers: Docs MCP https://mcp.sandbox.airwallex.com/docs (no login, use for exact fields) and Developer MCP https://mcp.sandbox.airwallex.com/developer (sandbox login). Add to Claude Code with claude mcp add-json. Never use the production AgentOS MCP.
- Verify the connection by listing global accounts; an empty list is fine.
- REST auth: POST /api/v1/authentication/login with x-client-id and x-api-key headers, no body. Bearer token lasts 30 minutes, so auto-refresh it.
- Developer MCP cannot create a global account. Create it in code via POST /api/v1/global_accounts/create. country_code is the account country, not the currency, and BE is rejected.
- Fund via POST /api/v1/simulation/deposit/create. The balance is usable immediately even if the response says PENDING.
- Airwallex API amounts are in major units (e.g. 100.50). Our code stores integer minor units, so convert only at the Airwallex client boundary, with tests.
- A FAILED transfer auto-cancels within seconds. Slow polling can miss FAILED and lose failure_reason. So: treat webhooks as the primary signal, persist every status and failure reason the first time we see it, and branch on both FAILED and CANCELLED.
- Webhook events to handle: payout.transfer.paid, payout.transfer.failed, payout.transfer.cancelled.
- Stable request_id on every mutating call.
1. Never invent API fields or endpoints. Verify with the Docs MCP or official docs. If unsure, stop and ask me.
2. Secrets only in .env (git-ignored). Provide .env.example. Never log keys.
3. The LLM never moves money directly. It calls typed tools; every money-moving tool passes deterministic code checks first.
4. All money as integer minor units. Every state change is in a DB transaction. Every external call has an idempotency key.
5. No feature is "done" until it has tests that pass.
6. Small, reviewable commits. Explain what you changed and why.
7. Keep a PRIOR_WORK.md that separates pre-existing Quantum Chartered patterns from code written during the hackathon. Be honest.
8. Label anything simulated as simulated, in the UI and README.
- TypeScript monorepo. Backend: Fastify + PostgreSQL + Drizzle. Zod for all schemas.
- LLM: Claude via the Anthropic API with tool use.
- Frontend: one web operator console (React + Vite or Next.js). Clean, minimal, off-white/black.
- Tests: Vitest + fast-check (property-based).
- Formal model: TLA+ checked with TLC (or Apalache), in /spec.
- Docker Compose for one-command local setup.
```
Webhooks / poller ──► Event store (append-only, deduplicated, ordered by version)
                              │
                              ▼
               Incident engine (deterministic state machine)
                              │
          ┌───────────────────┼─────────────────────┐
          ▼                   ▼                     ▼
  Evidence collector   Policy & safety core    LLM investigator
  (Airwallex, ledger,  (finality, dup-lock,    (reads emails, compares
   supplier emails)     balance, limits)        evidence, explains, recommends)
                              │
                              ▼
                 Human approval (cryptographically bound)
                              │
                              ▼
          Executor (replacement transfer, idempotent) ──► Hash-chained audit log
```
Work in order. After each phase: run tests, show me a summary, and wait for my OK.
- Read the builder guide and API docs. Write docs/PLAN.md covering the transfer state machine as Airwallex defines it, our incident state machine, data model, tool list, and risks.
- List any questions for me.
- Airwallex client with auth, token refresh, typed responses, retries, idempotent request_ids.
- Scripts: fund wallet, create beneficiary, create transfer, move it to SENT, PAID or FAILED with a chosen failure_type.
- Webhook receiver with signature verification, deduplication and out-of-order handling. Expose it with a tunnel (e.g. ngrok or cloudflared) for sandbox testing.
- Backup poller that never overwrites a captured FAILED + failure_reason with a later bare CANCELLED.
- Add a test for the "FAILED flips to CANCELLED in seconds" case.
- Incident lifecycle: OPEN → INVESTIGATING → RECOMMENDED → AWAITING_APPROVAL → EXECUTING → MONITORING → RESOLVED / ESCALATED.
- Duplicate lock: at most one active payment per (supplier obligation). A replacement is only allowed when the original is in a confirmed terminal failure state. Enforced with a DB constraint plus a lock, not just app logic.
- Balance check before replacement.
- LLM investigator with typed read-only tools plus one gated propose_replacement tool. Output is a structured incident report (JSON schema), and the UI renders it.
- Three demo paths must work end to end: 
  1. Original still SENT, within window → WAIT.
  2. Original FAILED with a bank return → REPLACE → human approves → replacement PAID → original's fate recorded → RESOLVED.
  3. Supplier email asks to "resend to our new bank account" → ESCALATE, payment blocked.
- Operator console: incident list, timeline, evidence panel, recommendation, approve/reject, audit log.
1. Evidence-grounded claims. Every sentence in the AI report must cite evidence IDs. A verifier rejects uncited or unsupported claims and flags contradictions between sources.
2. Adversarial test suite. Prompt injection in supplier emails, bank-detail swaps, replayed or out-of-order webhooks, concurrent approvals, double clicks, status change during approval. Output a scoreboard (attacks run / attacks succeeded = 0).
3. Bound approvals + tamper-evident log. An approval is an HMAC/signature over (incident ID, amount, currency, beneficiary ID, evidence-set hash, transfer state version). Any change invalidates it. The audit log is hash-chained, with a verify command.
4. Arrival probability + expected-cost decision. Estimate P(original still arrives) from elapsed time, rail and status, then compare expected costs of wait, replace and escalate (late-payment cost vs double-pay risk vs recovery cost). Priors are illustrative and clearly labelled because the sandbox has no real history. Code decides thresholds; the LLM only explains.
5. Formal proof. TLA+ model of transfers, replacements, webhooks, retries and approvals. Invariant: never more than one successful payment per obligation. Show TLC exploring all interleavings with no violation. Mirror the invariant with fast-check property tests against the real code.
6. Replay / time travel. Rebuild any incident from the event store and show what the agent knew at each step.
- README.md: problem, demo GIF, one-command setup, architecture diagram, what's simulated, eval results table.
- EVAL.md: scenario matrix (8–10 cases) with expected vs actual decision, time to recommendation, duplicates blocked.
- A video script under 5 minutes: goal → agent plan → new evidence → revised decision → resulting status, then the attack scoreboard and proof result.
- A final self-review for security, idempotency, race conditions and secrets.
This project will be built first by one coding agent (Codex), then continued and enhanced by another (Claude Code). The next agent will have no memory of your session, so the repo must explain itself.
- Use git from the first minute. One commit per finished step, with clear messages.
- Keep docs/PROGRESS.md updated after every step: 
  - Phase and step currently in progress
  - What is done and tested (with test commands)
  - What is half-done, and exactly where you stopped
  - Known bugs, shortcuts and TODOs
  - Decisions made and why (or link to docs/DECISIONS.md)
- Never leave the repo broken at the end of a session. If you must stop mid-task, commit to a branch named wip/<task> and note it in PROGRESS.md.
- Keep README.md setup steps accurate at all times so a fresh agent can run everything with one command.
- Start with Phase 0 only. Show me docs/PLAN.md and your questions before writing code.
- When you need API keys or sandbox access, tell me exactly what to create and where to put it.
- If something in the Airwallex sandbox behaves differently from the guide, tell me and propose a workaround. Do not fake it.
- Prefer a smaller thing that fully works over a bigger thing that half works.