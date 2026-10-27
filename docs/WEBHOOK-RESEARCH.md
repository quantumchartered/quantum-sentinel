# Webhook and reconciliation research

Research date: 2026-10-27. Phase 0 documentation only. Sources below were read; no sandbox requests, webhook deliveries, or runtime tests were performed for this document. Implementation choices are explicitly identified as proposed.

## Verified delivery contract

The event envelope includes `id`, `name`, `account_id`/`org_id` where applicable, `data.object`, `created_at`, and `version`. The last field is the subscription's **API schema version**, not an increasing transfer-state version. `data.object` follows the resource's Retrieve API schema.

The signature is the hex digest of HMAC-SHA256 using the subscription secret and the concatenation of the exact `x-timestamp` header string followed by the raw, unchanged request body. `x-timestamp` is Unix milliseconds. Verification precedes JSON parsing; after signature verification the receiver applies its timestamp tolerance. Each notification URL has its own secret. The subscription UI allows an explicit API version. [Source: Listen for webhook events](https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events)

Events can be duplicated or delivered out of order. Their `id` remains stable on retries. Airwallex recommends `created_at` for event-time ordering. Delivery succeeds only on HTTP 200; other responses and timeouts cause retries with exponential backoff for approximately three days. The reviewed contract does not promise a monotonic resource sequence number. [Source: Webhooks overview](https://www.airwallex.com/docs/developer-tools/webhooks/webhooks-overview)

## Failure fields depend on API version

The 2026-06-30 API change replaces top-level transfer `failure_reason` and `failure_type` with `failure`; it also changes the separate funding-failure representation. Do not build a current-version parser solely around the older guide fields. [Source: API changelog, 2026-06-30](https://www.airwallex.com/docs/api/changelog)

The current transfer schema documents `failure.code`, `failure.message`, `failure.details.type`, and `failure.details.reason_codes`. Funding failures are separate from payout failures. The published reference also contains legacy funding examples, so the selected version and real sanitized fixtures must resolve differences before implementation.

Transfer events include `payout.transfer.paid`, `payout.transfer.failed`, `payout.transfer.cancelled`, and lifecycle events such as `payout.transfer.sent`. Transfer resources contain `updated_at`. Creation requires `request_id`; seven-day duplicate protection is documented, with error `request_id_duplicate`. `GET /api/v1/transfers` accepts a `request_id` filter for uncertain-create reconciliation. [Source: Transfers API](https://www.airwallex.com/docs/api/payouts/transfers)

Airwallex says a failed transfer can automatically become cancelled within seconds. Failure can also occur after `PAID`; keep listening until arrival is confirmed. A cancellation snapshot cannot replace the retained failure evidence, and `PAID` alone is insufficient evidence of irreversible beneficiary receipt. [Source: Handle failed transfers](https://www.airwallex.com/docs/payouts/transfers/manage-transfers/handle-failed-transfers)

## Proposed ingestion and retention design

These are project design decisions, not claims about provider guarantees:

1. Require a configured subscription secret; use constant-time signature comparison and bounded body size. Never choose the verification key from an inbound request header. Verify account scope and configured schema version.
2. In a short database transaction, durably append the authenticated event and enforce a unique provider-event identity. Return 200 after that transaction commits; process the incident asynchronously. A failed database write must not be acknowledged as persisted.
3. Keep the exact authenticated raw body, digest, provider event time, local receipt time, API version, and provenance in restricted storage. Redact secrets and bank details from operational logs.
4. Assign our own aggregate version under a database lock. Store provider `version` separately. Record both what occurred and when the system learned it so replay can reconstruct the original decision context.
5. Preserve every failure observation, including late events. Never erase a specific failure when a later poll returns absent failure fields or a generic cancellation. A latest-status projection and an immutable failure-evidence history serve different purposes.
6. Treat conflicting or equal-time snapshots as unresolved evidence, trigger retrieval, and block replacement until reconciled. Do not use a numeric status ranking: `PAID` can precede `FAILED`.
7. A timed-out create keeps its original request ID and obligation lock. Reconcile by request ID before retrying; never assume provider deduplication persists beyond its documented window.

## Auth and balance facts

`POST /api/v1/authentication/login` takes `x-client-id` and `x-api-key` headers and no request body in the documented example. The documented success is **201 Created**, with `token` and ISO8601 `expires_at`; tokens last 30 minutes. Cache and refresh using returned expiry. [Source: API Access Token](https://www.airwallex.com/docs/api/authentication/api_access_token)

`GET /api/v1/balances/current` supports `account_type=cash` and returns per-currency records including `available_amount`, `pending_amount`, `reserved_amount`, `prepayment_amount`, and `total_amount`. Proposed affordability checks use available cash in the source currency, converted into our integer minor-unit representation, with explicit fee and local reservation handling. [Source: Balances API](https://www.airwallex.com/docs/api/core_resources/balances)

## Phase 1 verification gates

- Pin matching REST and webhook API versions; obtain sanitized fixtures for failed and cancelled events and their Retrieve responses. Retain legacy adapters only if the chosen account/version requires them.
- Verify whether retries and manual re-triggers renew `x-timestamp`; choose and test a tolerance that rejects replay without unintentionally dropping valid delayed delivery. The reviewed pages do not specify this renewal behavior.
- Test invalid signatures, mutated raw bodies, repeated event IDs, reversed delivery order, identical timestamps, missing failure fields, and `FAILED` followed quickly by `CANCELLED`.
- Test an ambiguous transfer-creation timeout and request-ID reconciliation, plus expiry beyond the provider's deduplication window.
- Establish which provider evidence proves the original cannot still arrive. Unknown finality must block replacement; neither probability estimates nor a human click may override that constraint.

No executable tests exist at Phase 0. This document records requirements for later tests, not passed results.
