# Official requirements and verified facts

Checked **October 27, 2026** by Claude Code. This file keeps three things apart:

1. **Confirmed rules:** what an official or organiser source says, with the source.
2. **Discrepancies:** places where sources disagree with each other or with our directive.
3. **Our strategy:** what we choose to do about it. This is our decision, not a rule.

Mandatory values: **yes** (stated as required), **no** (guidance or recommendation), **unknown** (not stated anywhere we could read).

Sources:

- [G] Builder guide, https://airwallexdev.com/guide. Unofficial developer lab, sandbox only.
- [S] Setup page, https://airwallexdev.com. Unofficial developer lab. It says "check Airwallex's official docs" because APIs and MCP may change.
- [D] Official API docs, https://www.airwallex.com/docs, read through the Airwallex Docs MCP (`mcp.sandbox.airwallex.com/docs`).
- [L] Third-party competition listing, https://internshala.com/competitions/?p=12217. Not the organiser.
- [F] The founder's Master Build Directive (`AGENTS.md` §1). The founder says it was checked against the HackerEarth page on Oct 27. We could not open that page ourselves.

## 1. Event rules (confirmed or founder-reported)

| # | Rule | Source | Mandatory | Status | How we satisfy it |
|---|---|---|---|---|---|
| E1 | Submit a working demo | F, L | yes | Two sources agree | Docker Compose demo plus Scenario Lab against the sandbox |
| E2 | Video walkthrough **under 5 minutes** | F, L | yes | Two sources agree | Script drafted in T5; aim for 4:30 |
| E3 | Repository link with setup instructions | F, L | yes | Two sources agree | README with a one-command setup, rehearsed from a fresh clone in T5 |
| E4 | Submission deadline **Nov 13, 2026** (about 10:29 AM America/Los_Angeles per F) | F, L | yes | The date matches in both. Only F gives the time | Plan to submit by **Nov 12, 22:00 PT**, at least 12 hours early. Founder to confirm the exact time on the team dashboard |
| E5 | Finalists Nov 15; Demo Day Nov 19, San Francisco, remote allowed | F, L | n/a | Two sources agree | The demo must also work over a remote screen share |
| E6 | Teams of 1–4 | F, L | yes | Two sources agree | Founder track |
| E7 | Sandbox only; no real money | F, G, S | yes | Three sources agree | The adapter rejects any base URL other than `https://api.sandbox.airwallex.com`, with a test |
| E8 | Participants keep their IP | F | n/a | Founder-reported only | — |
| E9 | Prizes: Founder's Choice $30k, Judges' Choice $20k, Visa $15k, Metal $15k; credits: Claude $10k, AWS $50k, Base44 $16k | F; L confirms the first three | n/a | Metal and the credits are founder-reported only | Visa and Metal require their tooling. Not in scope unless the founder decides otherwise |
| E10 | No official judging rubric is published | F, G | n/a | G gives guidance only (§2 below) | We never cite a rubric. We follow G's "strong build" guidance |

## 2. Builder-guide guidance (G; mandatory = no, but this is what reviewers will look for)

| # | Guidance | How we satisfy it |
|---|---|---|
| B1 | The agent chooses differently when a balance, deadline, piece of evidence or risk changes | In Scenario A, WAIT turns into REPLACE after a real FAILED webhook. A balance-insufficient case ends in ESCALATE. The decision change is a persisted state transition |
| B2 | Amounts, limits, reserves, validation, duplicate protection and state transitions live in code | `packages/policy` is pure code. The LLM only proposes |
| B3 | "If the agent should make the same choice every time, write the rule in code" | Finality, the bank-detail-change rule, balance and duplicate rules are all deterministic |
| B4 | Typed tools, not unrestricted credentials | Zod-typed read tools plus `propose_action`. Credentials stay server-side |
| B5 | Approvals bound to amount, currency, counterparty, terms and evidence | HMAC approval over the tuple in `AGENTS.md` §6.4 |
| B6 | Sandbox-only simulation calls sit behind one interface | `packages/airwallex/simulation` is a separate module. The agent never has access to it |
| B7 | Demo shows the goal → plan → new information → revised decision → resulting status, and ends in a financial action or an escalation | Scenario A script |
| B8 | Kit 3 flow: fund the wallet, send a transfer, hold it in an intermediate state, fail it with a chosen type, replace it under a duplicate lock | Scenario A |

## 3. Airwallex technical facts

| # | Fact | Source | Mandatory | Verified how | Strategy |
|---|---|---|---|---|---|
| A1 | Base URL `https://api.sandbox.airwallex.com` | S, D | yes | Docs | Exact-match allowlist |
| A2 | `POST /api/v1/authentication/login`, headers `x-client-id` and `x-api-key`, no body; returns `token` and `expires_at`; documented success is **201** | S, D | yes | Docs | Refresh at least 5 minutes before `expires_at`, using a single shared refresh. Accept 200 and 201 until the sandbox confirms which one it returns |
| A3 | Token lasts 30 minutes | S, D | n/a | Docs | Use the returned `expires_at`, not a hard-coded 30 minutes |
| A4 | `POST /api/v1/transfers/create`: `request_id` is required, and IDs used in the past 7 days are rejected as duplicates | D | yes | Docs MCP | Permanent local uniqueness. A timeout means we reconcile through `GET /api/v1/transfers?request_id=` and never generate a new ID |
| A5 | `request_id` must be **10–50 characters**; outside that range returns code `018` | G | yes | Guide only | Use a UUID (36 characters). Zod enforces 10–50 |
| A6 | `POST /api/v1/simulation/transfers/{id}/transition` with `next_status` (required: OVERDUE, PROCESSING, SENT, PAID, FAILED, CANCELLED) and optional `failure_type` (32 documented values, including `BENEFICIARY_BANK_RETURNED`, `RECALL_REQUESTED`, `INSUFFICIENT_FUNDS`) | D | yes | Docs MCP (full enum captured) | Zod enum of the documented values. Scenario A uses `BENEFICIARY_BANK_RETURNED` |
| A7 | Simulate SENT before PAID; `failure_type` only applies after SENT; prefer FAILED + type over a bare cancel (which gives `failure_reason: "simulation"`) | G | yes for the demo | Guide only | Scripts enforce the order. Confirm with a real sandbox run in T1 |
| A8 | FAILED auto-cancels within seconds; slow polling misses it | G, S, D | yes | Docs + guide | Webhooks are the primary signal. Failure observations are append-only. A later bare CANCELLED never erases them |
| A9 | PAID can later become FAILED | D | yes | Docs | PAID is never treated as final. The incident stays in MONITORING. Late failures after PAID escalate |
| A10 | Global accounts: `POST /api/v1/global_accounts/create` with `request_id`, `country_code` (account country, not currency; BE rejected), `required_features: [{currency, transfer_method}]`. Developer MCP cannot create one | S | yes | Setup page only | Script `create-global-account` with `country_code: "US"` and `[{currency:"USD", transfer_method:"LOCAL"}]`. Confirm the fields in the Docs MCP before writing the script |
| A11 | Deposit: `POST /api/v1/simulation/deposit/create` with `global_account_id`, `amount`, `payer_name`. Balance usable immediately even if PENDING | S | n/a | Setup page only | Check the balance after depositing rather than trusting the response status |
| A12 | Amounts are major units | S, G | yes | Docs examples | Integer minor units internally. Convert only in `packages/airwallex`. Property tests check round-trips |
| A13 | Webhook signature: `x-signature` = hex HMAC-SHA256(secret, `x-timestamp` + raw body). Duplicates and out-of-order delivery happen. Deduplicate on event `id`, order by `created_at`, return 200 or Airwallex retries for about 3 days | S, D | yes | Docs + setup page | Verify the signature before parsing JSON. Unique event ID in the database. Our own aggregate version |
| A14 | Webhooks are configured **in the web app** (Settings > Developer > Webhooks), not through the API | S | yes | Setup page | Founder step, after the tunnel exists |
| A15 | Events: `payout.transfer.paid`, `.failed`, `.cancelled` (and `.sent` per D) | S, D | yes | Docs + setup page | Subscribe to all four |
| A16 | Sandbox SWIFT payout fee: flat **EUR 12.85** | G | n/a | Guide only | Our first slice uses USD LOCAL, not SWIFT. If SWIFT is added, reserve two fees |
| A17 | Original and replacement need different `request_id`s | G | yes | Guide | Each payment attempt gets its own operation ID. Tests cover this |
| A18 | Never close the incident just because the replacement is PAID; record the original's fate | G | yes | Guide | RESOLVED requires an `original_fate` record. Database check plus test |
| A19 | Never use the production AgentOS MCP | F, S | yes | S describes it as the production server | `.mcp.json` contains only the docs and developer servers |
| A20 | Additional business entity must be named "Sandbox Business" or "New Business Sandbox", or it stays "In review" | S | yes | Setup page | Founder step |

## 4. Discrepancies we found (do not paper over)

| # | Our directive or the guide says | Official docs say | Resolution |
|---|---|---|---|
| X1 | `POST /beneficiaries/schema` | `POST /api/v1/beneficiary_api_schemas/generate` (also `/beneficiary_form_schemas/generate`, `/beneficiaries/validate`) | Use the official path. The guide path is shorthand |
| X2 | Responses carry `failure_reason` / `failure_type` | Since API version `2026-06-30`, transfer responses use a `failure` object (`failure.code`, `.message`, `.details.type`). Simulation still **accepts** `failure_type` as input | Pin `x-api-version`. Decode the shape we actually observe, store raw bytes, keep one normalized `FailureObservation` |
| X3 | Deposit response says PENDING | The deposit reference documents optional `status`, default `SETTLED` | Record what the sandbox actually returns. Gate on the balance read |
| X4 | Build starts Oct 27 | [L] says the build period starts Oct 25 | Harmless. The deadline matches |
| X5 | Organiser is HackerEarth | We could not confirm the host independently | Founder to confirm on the dashboard |
| X6 | — | Request example sends `transfer_amount` as a **string** (`"50"`). Responses return **JSON numbers** (`68.13`) | Serialize requests as decimal strings. Parse responses through a decimal-safe path, never float arithmetic |
| X7 | — | Duplicate errors are spelled both `request_id_duplicate` and `duplicate_request_id`. Also `409 request_pending` | Normalize all of them to "reconcile the existing transfer" |
| X8 | Every mutating call needs a stable `request_id` | `beneficiaries/create` and `simulation/deposit/create` document no `request_id` field | Never invent the field. Use a local operation ID. On uncertainty, reconcile; never retry blindly |
| X9 | Codex snippet on [S] uses `experimental_use_rmcp_client = true` | Codex's current CLI supports HTTP MCP directly (per Codex, Phase 0) | Codex-only detail. Claude Code uses `.mcp.json` |
| X10 | Generic webhook docs: payload in `data.object` | Payouts webhook reference: transfer directly in `data` | Parser accepts both; anything else fails closed (D31) |

## 5. Unknowns for the founder

1. Is **pre-existing code** allowed? This decides whether we may re-implement or copy Quantum Chartered patterns (see `PRIOR_WORK.md`).
2. Must the repository be **public** at submission? Making it public needs founder approval (`AGENTS.md` §13).
3. Can one team win **several prizes**?
4. How do we claim **Claude API credits**? A Claude Code subscription does not include API usage.
5. The exact **submission timestamp** and the organiser page (X4, X5).

Ask these at devhelp@airwallex.com or on the team dashboard. **We will not email anyone without founder approval.**
