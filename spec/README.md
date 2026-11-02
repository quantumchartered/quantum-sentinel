# Formal model: no double payment

`Sentinel.tla` is a TLA+ model of how Sentinel replaces a failed supplier payment without ever paying twice. TLC, the TLA+ model checker, explores **every** reachable state of the model, not a sample.

```bash
pnpm spec
```

This builds a pinned TLC container (`spec/Dockerfile`: TLA+ tools 1.7.4, checked by SHA-256), checks a matrix of configurations, and writes [`RESULTS.md`](RESULTS.md). It exits 1 if any row behaves differently from what `run.mjs` records. Needs Docker. It takes about two minutes, most of it the large configuration. Generated configs and raw TLC output go to `spec/build/` (git-ignored).

## What it found

The first run found a real gap in the executor, now fixed. A worker whose lease had expired, but which was still alive, could be BLOCKED (for example by a transient balance-read error) and write `NOT_SENT` while a second worker that had re-claimed the execution was sending. The obligation's fence was then gone while a transfer was live, so a second replacement could be approved and sent.

The fix is `releaseOrHold` in `packages/db/src/execution.ts`. It releases the fence only when the execution has been claimed exactly once and the payment is still open. Otherwise the payment stays `UNCERTAIN` (still blocking) and a person decides. `packages/db/src/safety.int.test.ts` ("Model-checked interleavings") replays TLC's counterexamples against the real executor and Postgres, and those tests fail if the old rule is restored. The `pre-fix` row in RESULTS.md keeps the old rule, so the counterexample stays on record.

## What is modelled

One obligation: the original transfer plus up to *N* replacement payments, each with its own execution row, run by *W* workers. Each action is **one database transaction or one provider call** in the code, so TLC interleaves them exactly as concurrency can.

| Model action | Code |
| --- | --- |
| `ProviderMove` | Airwallex: SENT→PAID, SENT→FAILED, PAID→FAILED (late), FAILED→CANCELLED (auto-cancel) |
| `Webhook`, `Poll` | `payout.transfer.*` webhooks (late, duplicated, reordered, or never) and the poller, into the append-only transfer history (`event-store.ts`) |
| `ConfirmedFailed` | `classifyFinality` = `CONFIRMED_FAILED` (`packages/policy/src/transfer-history.ts`) |
| `ConfirmOriginalFailure` | `syncPaymentFinality`: original → `FAILED_CONFIRMED`, which releases its fence |
| `Approve` | `approveProposal`: under the obligation + incident locks, `decide()` with `otherBlockingPayments = 0`, insert of the `INTENDED` payment, guarded by `payments_one_blocking_per_obligation` |
| `Claim`, `ExpireLease`, `Crash` | `executeReplacement` step 1: claim `PENDING`, or `CLAIMED`/`UNCERTAIN` with an expired lease; `attempts += 1` |
| `LookupFound`/`None`/`Error` | step 2: `findTransferByRequestId` when the payment is `UNCERTAIN` or `attempts > 1` |
| `RevalidateGo`, `RevalidateBlock` | step 3: poll the original, then re-check finality, policy and the approval in one locked transaction. A block can happen for reasons outside the model (approval expired, balance, beneficiary), so it is always allowed |
| `SendOk`, `SendLost*`, `SendRejected` | step 4: `createTransfer` with the payment's stable `request_id`; response received, lost after or before the provider stored it, or a definite rejection |
| `FinishSuccess`, `FinishUncertain`, `Finish` (rejected) | `finishSuccess`, `finishUncertain`, `finishRejected`, each its own transaction, possibly much later for a stalled worker |
| `ReleaseOrHold` | `releaseOrHold` |

**Properties.**
- `NoDoublePayment`: at most one transfer for the obligation can deliver money.
- `FenceHeld`: every transfer that can still move money has a payment record that blocks the obligation. This is the stronger property that makes `NoDoublePayment` hold.
- `AtMostOneBlocking`: the database never holds two blocking payments.
- `TypeOK`.

**Defence matrix.** `Disabled` switches individual defences off, which shows which ones the result depends on and which only back others up. **Witness** rows show TLC actually reaches the interesting states (a replacement sent, two workers on one execution, a held fence, a live transfer under an uncertain record), so the result is not vacuous.

## Assumptions (what the proof rests on)

- **A1.** A transfer Airwallex reports as FAILED never later delivers money. FAILED only moves to CANCELLED. A failure *after* PAID is a return, so that money is no longer delivered.
- **A2.** Airwallex de-duplicates `request_id`: creating a transfer with a `request_id` it already holds does not create a second one. The adapter turns the duplicate error into the existing transfer (`packages/airwallex/src/client.ts`).
- **A3.** A definite rejection of a create (a 4xx that is not a duplicate) means the provider holds no transfer under that `request_id` at that moment.
- **A4.** `findTransferByRequestId` sees every transfer the provider has created under that `request_id`.
- **A5.** Nobody pays the supplier outside Sentinel.

## What it does not cover

- **Bounded sizes.** The checks run up to 3 workers, 3 replacements and 4 claims per execution. Larger sizes are not checked.
- **Abstracted logic.** Money amounts, balances, fees, beneficiaries, approval signatures and expiry, tenants and the audit chain are not modelled. The executable tests cover those (`pnpm test`, `pnpm test:integration`, `pnpm attacks`, `pnpm eval`).
- **No liveness.** The model makes no claim that an incident eventually resolves. A held `UNCERTAIN` payment waits for a later attempt or for a person.
- **No refinement proof.** The match to the code is by construction and review, plus the replay tests, not a formal proof that the code refines the model.
