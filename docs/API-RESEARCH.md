# Airwallex contract research — Phase 0

Research date: 2026-10-27. These are documentation findings, not sandbox test results. No transfer, funding, beneficiary, or cancellation operation was performed for this research. The Docs MCP was initialized and searched during Phase 0; it returns a mixture of current and legacy material. Version-specific reference checks and captured sandbox fixtures remain Phase 1 requirements.

## Version decision

**Candidate pin: `2026-08-21`, pending sandbox contract verification.** The official versioning page identifies this as the latest version. The account default otherwise applies; `x-api-version` can select a version for sandbox testing. Confirm the account and webhook versions before implementing decoders. Version-specific reference URLs were not accessible through the research browser, so the current reference and changelog are the evidence available today. [Versioning](https://www.airwallex.com/docs/api/versioning)

The `2026-06-30` change replaces transfer response `failure_reason` and `failure_type` with a `failure` object. Do not assume the brief's legacy response shape on the candidate pin. Store raw payloads, normalize failure evidence internally, and add a legacy adapter only for an explicitly identified older contract. Simulation request `failure_type` is a separate input field. [Changelog](https://www.airwallex.com/docs/api/changelog)

## Transfer lifecycle

The following graph is documented for API versions `2025-06-30` onward. `Created` represents the creation action, not an API status. [Transfer statuses](https://www.airwallex.com/docs/payouts/transfers/create-a-transfer/transfer-statuses)

```text
Created -> SCHEDULED | IN_APPROVAL
IN_APPROVAL -> SCHEDULED | APPROVAL_RECALLED | APPROVAL_REJECTED | APPROVAL_BLOCKED
APPROVAL_RECALLED | APPROVAL_REJECTED | APPROVAL_BLOCKED -> IN_APPROVAL
SCHEDULED -> PROCESSING | OVERDUE | CANCELLED
OVERDUE -> PROCESSING | CANCELLED
PROCESSING -> SENT | FAILED
SENT -> PAID | FAILED
PAID -> FAILED | end
FAILED -> CANCELLED
CANCELLED -> end
```

`PAID` means the banking partner processed the transfer; subsequent clearing-system or recipient-bank rejection can still cause `FAILED`. `FAILED` automatically becomes `CANCELLED` within seconds. Continue failure monitoring after `PAID` until arrival is confirmed. Airwallex approval states are distinct from our operator approval state machine. Funding also has its own status; do not merge it with transfer status. [Transfer statuses](https://www.airwallex.com/docs/payouts/transfers/create-a-transfer/transfer-statuses)

## Reference fields and recovery

Current transfer failure fields are `failure.code`, `failure.message`, `failure.details.type`, and `failure.details.reason_codes`. The reference exposes `POST /api/v1/transfers/create`, `GET /api/v1/transfers/{id}`, and `GET /api/v1/transfers`; list queries support `request_id`. Creation IDs are deduplicated for seven days, so ambiguous results should be reconciled by that ID. [Transfer API](https://www.airwallex.com/docs/api/payouts/transfers)

The current cancellation route is `POST /api/v1/transfers/{id}/cancel`. Its reference conflicts with the older `/transfers/cancel/{id}` example in the failed-transfer prose. Use the reference route, verified against the selected sandbox contract, if cancellation is later in scope. [Transfer API](https://www.airwallex.com/docs/api/payouts/transfers), [failed-transfer guide](https://www.airwallex.com/docs/payouts/transfers/manage-transfers/handle-failed-transfers)

Transfer amounts use major currency units at the boundary. However, the current transfer reference describes `application_fee_options.amount` as a string containing minor units. That optional feature is out of the initial scope; conversion must be field-specific, never a blanket division applied to every monetary field. [Transfer API](https://www.airwallex.com/docs/api/payouts/transfers), [builder guide](https://airwallexdev.com/guide)

## Sandbox simulation

`POST /api/v1/simulation/transfers/{id}/transition` accepts required `next_status` and optional `failure_type`. Documented statuses: `OVERDUE`, `PROCESSING`, `SENT`, `PAID`, `FAILED`, `CANCELLED`. Relevant exact failure values include `BENEFICIARY_BANK_RETURNED`, `RECALL_REQUESTED`, `INSUFFICIENT_FUNDS`, `DUPLICATION_RETURN`, `ACCOUNT_CLOSED`, `INVALID_ACCOUNT_NAME_OR_NUMBER`, `CHANNEL_TIMEOUT`, `SYSTEM_ERROR`, and `OTHER`. Preserve the documented spelling and validate the chosen subset. [Simulation API](https://www.airwallex.com/docs/api/simulation/transfers/api)

The builder guide requires reaching `SENT` before `PAID`, and before applying a chosen failure type. It recommends `FAILED` plus a type because bare cancellation supplies only a generic simulation reason. Original and replacement need distinct request IDs. Budget both fees if both transfers use SWIFT. These are documented sandbox expectations, not observations from this repository. [Builder guide, Kit 3](https://airwallexdev.com/guide)

## Other contract discrepancies

The documented beneficiary schema route is `POST /api/v1/beneficiary_api_schemas/generate`, not the brief's `/beneficiaries/schema`. Select the schema using the actual corridor parameters before building beneficiary payloads. [API and form schemas](https://www.airwallex.com/docs/payouts/beneficiaries/using-api-and-form-schemas)

No `request_id` appears in the inspected request bodies for `POST /api/v1/beneficiaries/create` or `POST /api/v1/simulation/deposit/create`. Do not invent an idempotency field or assume that transfer creation's guarantee covers those endpoints. Assign a stable local operation ID to every mutation; for an endpoint without a documented deduplication key, reconcile uncertain results or stop for operator review instead of blindly retrying. The deposit schema's optional unique `statement_ref` is not sufficient documentation of retry semantics. [Beneficiary API](https://www.airwallex.com/docs/api/payouts/beneficiaries/create), [deposit simulation API](https://www.airwallex.com/docs/api/simulation/deposits/create)

The deposit reference now documents optional `status` with a default of `SETTLED`, whereas the guide describes an observed `PENDING` response with immediately usable balance. Record the actual sandbox response and balance; do not assert either behavior was tested here. [Deposit simulation API](https://www.airwallex.com/docs/api/simulation/deposits/create), [builder guide](https://airwallexdev.com/guide)

## Errors, balances, and refunds

The errors guide documents `balance_insufficient` for insufficient Wallet funding. It names `duplicate_request_id` and legacy `request_id_duplicate`, with the existing transfer ID in the documented parameters. The current transfer reference still lists `request_id_duplicate` and also `409 request_pending`. This is a documentation inconsistency: fixture-test both duplicate spellings and the actual error envelope; never infer a new payment is safe from an unknown response. [Error codes](https://www.airwallex.com/docs/payouts/errors/transfer-error-codes), [Transfer API](https://www.airwallex.com/docs/api/payouts/transfers)

Cancellation can refund less than the transfer amount. Transfer fees are non-refundable, and third-party or FX cancellation costs may apply. Refund currency depends on account configuration and transfer details. A balance increase alone is not evidence that a particular original transfer was returned. [Failed-transfer guide](https://www.airwallex.com/docs/payouts/transfers/manage-transfers/handle-failed-transfers)

## Safety interpretation and proof limits

The following are proposed application policies, not additional Airwallex guarantees:

- Keep permanent operation identity and an obligation lock beyond the provider's seven-day deduplication window. An uncertain request retains its lock; timeout recovery reconciles the same request ID.
- Preserve failure observations even when later cancellation or polling omits them. An unexplained `CANCELLED` cannot authorize replacement.
- Require confirmed original failure/cancellation, attributable return or non-settlement evidence, sufficient available balance, unchanged beneficiary, and valid bound approval before replacement.
- Do not count historical `PAID` events as irreversible successes: an original may be paid and later returned. For the initial demo, propose escalating originals that ever reached `PAID`; demonstrate replacement from `SENT -> FAILED -> CANCELLED` instead.
- Define the formal invariant over modeled recipient settlement and the application's authorization rules. Explicit assumptions must include trustworthy provider evidence, inability of a terminally cancelled original to settle later, complete obligation ownership, and stable operation identity. TLC cannot prove a bank's external finality or an unmodeled manual payment.
- Resolution requires the original's fate and replacement arrival evidence. Label synthetic arrival confirmation as simulated; `PAID` alone is insufficient evidence of irreversible arrival.

## Phase 1 contract checklist

Before money-moving sandbox tests, confirm selected API/webhook versions; obtain schemas for the chosen corridor; capture redacted failure and duplicate-response fixtures; verify `SENT -> FAILED -> CANCELLED` timing and retained fields; determine attributable refund evidence; and document simulation discrepancies. Questions about finality, arrival evidence, and late-after-`PAID` replacement policy remain for the owner in `PLAN.md`.

## Docs MCP re-check by Claude Code (2026-10-27)

Confirmed in the official reference and used by `packages/airwallex`. **These are still documentation facts, not sandbox observations.**

| Endpoint / object | Finding used in code |
| --- | --- |
| `POST /api/v1/transfers/create` | `transfer_amount` and `source_amount` are **strings** in the request; `request_id`, `reason`, `reference`, `transfer_currency` required; `beneficiary_id` or inline `beneficiary` |
| Transfer response | Amounts are **JSON numbers**; `failure.{code,message,details.type,details.reason_codes}` |
| `GET /api/v1/transfers` | Filter `request_id`; `page`/`page_size`; `page=0` lifts the 30-day default window; response `items`, `page_after`, `page_before` |
| `GET /api/v1/balances/current` | Bare **array** of `{account_type, currency, available_amount, pending_amount, reserved_amount, total_amount, prepayment_amount}`; `account_type=cash` filter |
| `GET /api/v1/global_accounts` | `items[]` (pagination moved to `page_before/page_after` in 2024-08-07) |
| `POST /api/v1/global_accounts/create` | `request_id`, `country_code`, `required_features[{currency, transfer_method}]` |
| `POST /api/v1/simulation/deposit/create` | `amount` (number, required), `global_account_id` (required), optional `payer_name`, `payer_bankname`, `payer_country`, `reference`, `statement_ref`, `status` (default `SETTLED`); 201 |
| `POST /api/v1/beneficiary_api_schemas/generate` | Body `bank_country_code, account_currency, transfer_method, local_clearing_system, entity_type, type`; response `fields[{key,path,required,rule}]` |
| Error envelope | `code`, `message`, `source`, `details`, sometimes `trace_id`; transfer duplicate example `duplicate_request_id` with `details.id` |
| Webhook payload (Payouts page) | Transfer object directly in `data` (not `data.object`); `version` is the API schema version |
