# HackerEarth submission text

Copy each section into the matching field. Replace the two `<…>` links first.

---

## Project name

Quantum Sentinel

## Tagline (one line)

The AI financial-operations employee that investigates stuck supplier payments on Airwallex, changes its mind when the evidence changes, and cannot pay twice.

## Track

Kit 3: Payment Ops Incident Commander (open categories: Founder's Choice, Judges' Choice)

## Links

- Demo video: `<video link>`
- Repository: `<GitHub link>` (setup in the README: `docker compose up --build`)

## Description

**The problem.** Businesses that pay international suppliers lose hours to payment exceptions: a transfer is late, the supplier says it never arrived, and someone must decide whether to wait, re-send or escalate. Re-sending too early pays twice; waiting too long damages the supplier relationship. Most teams decide by hand, from scattered evidence, with no record of why.

**What Sentinel does.** Sentinel is a focused AI operations layer on top of Airwallex. For each incident it:

1. **Investigates.** Provider status, failure facts, internal records, the supplier's emails and the wallet balance. Every claim is labelled as a provider fact, internal record, synthetic fixture, AI interpretation or unknown, and linked to its evidence.
2. **Decides in code.** WAIT, REPLACE or ESCALATE comes from deterministic policy. A Claude investigator explains the decision with read-only tools; a grounding verifier rejects any claim it cannot back with evidence. The AI's only "write" is a proposal.
3. **Changes its mind for real.** When new evidence arrives (a bank return, a balance change, a fraudulent email) the recommendation is re-computed and the diff is shown.
4. **Acts safely.** A replacement needs a confirmed failure, a bound human approval (HMAC over amount, currency, beneficiary, evidence and provider state; 15-minute expiry; four-eyes), a re-check right before sending, and a new `request_id`. A database fence allows at most one live payment per invoice.
5. **Explains everything.** Decision Replay rebuilds what was known, proposed, blocked, approved and done from a hash-chained audit log.

**Built on Airwallex.** Authentication with token refresh, balances, global accounts, simulated deposits, the beneficiary schema and create, transfers create and get, and transfer simulation. Webhook verification and a backup poller that never loses a failure reason, even though FAILED auto-cancels within seconds. Scenario A has run end to end on the real sandbox: a USD 25,000 transfer, SENT, WAIT, "resend anyway" blocked, a bank return (code 90802), REPLACE, four-eyes approval, a replacement with a new `request_id`, PAID, resolved, books posted, audit verified. The sandbox also taught us three things we now handle:
- a 500 response that still took effect;
- failures that cancel in about 3 seconds;
- a failure "type" that is always `INCORRECT_ROUTING`, so Sentinel classifies failures by Airwallex's documented failure codes.

**Proof, not promises.**
- 187 unit tests and 129 PostgreSQL integration tests (including fast-check property tests of concurrency).
- 14 browser tests.
- An adversarial suite: 33 attacks, 0 succeeded (prompt injection, cross-tenant access, replayed and out-of-order webhooks, stale approvals, double-clicks, races).
- A 24-case evaluation matrix, all passing.
- A TLA+ model of the no-double-payment rule, checked by TLC over 1.4 million states. It found a real race in our executor, which we fixed and now test against.

**Honest limits.**
- The investigator in the demo is the labelled "Mock AI": the live Claude path is built and tested with scripted models but was not run with a real key.
- Webhooks on the sandbox were not exercised (the poller covered the run).
- The cost estimate uses illustrative priors and is advisory only.

Full list: `SECURITY_AND_LIMITATIONS.md`.

## How to run

```bash
docker compose up --build
```

Open http://localhost:4000, sign in with a token from `.local/demo-tokens.json`, open Scenario Lab and start Scenario A. Without keys it runs in clearly labelled MOCK mode; with sandbox keys in `.env`, `pnpm sandbox scenario-a` runs the same flow on the Airwallex sandbox.

## Tech

TypeScript monorepo: Fastify 5, PostgreSQL with Drizzle (partial unique index fence, append-only triggers, double-entry ledger), Zod, React 19, Vite and Tailwind, Anthropic Messages API (tool use and structured output), Vitest, fast-check, Playwright, TLA+/TLC.

## Team and prior work

Quantum Chartered. Built during the hackathon (Oct 27 – Nov 13, 2026) in a new repository; see `PRIOR_WORK.md`.
