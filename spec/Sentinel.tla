------------------------------ MODULE Sentinel ------------------------------
(***************************************************************************)
(* Quantum Sentinel's no-double-payment design, for ONE obligation: the    *)
(* original transfer and up to |Replacements| replacement payments, each   *)
(* with its own execution row, run by |Executors| outbox workers.          *)
(*                                                                         *)
(* Every step below is ONE database transaction or ONE provider call in    *)
(* the implementation, so TLC explores every interleaving of them,         *)
(* including a worker that pauses after its lease expired (a "zombie")     *)
(* and comes back later. Mapping to code: spec/README.md.                  *)
(*                                                                         *)
(* Environment (anything may happen, in any order):                        *)
(*   - Airwallex moves the original SENT -> PAID -> FAILED or              *)
(*     SENT -> FAILED -> CANCELLED (FAILED auto-cancels);                  *)
(*   - webhooks are delivered late, twice, out of order or never; the      *)
(*     poller reads the current state;                                     *)
(*   - leases expire, workers crash, provider responses are lost before    *)
(*     or after the transfer was created, revalidation may block for       *)
(*     reasons outside this model (approval expired, balance, beneficiary).*)
(*                                                                         *)
(* Disabled: a set of defences to switch OFF, to show which ones the       *)
(* proof depends on. {} is the implemented design.                         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Executors,      \* outbox worker processes
  Replacements,   \* replacement payments that may be proposed for the obligation
  MaxAttempts,    \* bound on claims per execution (keeps the state space finite)
  NoJob,          \* model value: a worker holds no execution
  Disabled        \* subset of Defences

Defences == {
  "typed_failure",      \* classifyFinality needs an observed FAILED (not a timeout, not a bare CANCELLED)
  "unique_index",       \* payments_one_blocking_per_obligation (DB partial unique index)
  "locked_checks",      \* decide()'s duplicate check runs under the obligation + incident row locks
  "revalidate",         \* executor re-reads the original and re-checks policy before sending
  "lookup",             \* executor looks the request_id up before re-trying
  "stable_request_id",  \* a retry reuses the payment's request_id (provider de-duplicates)
  "lease",              \* only one worker may hold an execution's unexpired lease
  "sole_attempt_release" \* release the fence only if no other attempt can still reach the provider
}

ASSUME Disabled \subseteq Defences
ASSUME MaxAttempts \in Nat \ {0}

On(d) == d \notin Disabled

----------------------------------------------------------------------------
\* Provider-side status of the original. Live = can still deliver, or has delivered, money.
OrigStates == {"in_flight", "paid", "failed", "cancelled"}
Live == {"in_flight", "paid"}

\* Sentinel payment states (payments.state). Blocking ones hold the obligation's fence.
PayStates == {"none", "intended", "uncertain", "dispatched", "not_sent"}
Blocking == {"intended", "uncertain", "dispatched"}
ExecStates == {"none", "pending", "claimed", "uncertain", "succeeded", "blocked", "rejected"}
PCs == {"idle", "claimed", "looked", "go", "sent_ok", "sent_lost", "rejected"}

VARIABLES
  otr,        \* provider: the original transfer's current status
  hist,       \* provider: every status the original has had (what webhooks can report)
  seen,       \* Sentinel: statuses observed for the original (append-only transfer history)
  origPay,    \* Sentinel: "dispatched" or "failed_confirmed" (releases the original's fence)
  tr,         \* provider: [Replacements -> {"absent","live"}] transfer under the payment's request_id
  stray,      \* provider: [Replacements -> {"absent","live"}] transfer under a DIFFERENT request_id (only if stable ids are off)
  pay,        \* Sentinel: [Replacements -> PayStates]
  ex,         \* Sentinel: [Replacements -> ExecStates] executions.status
  leaseLive,  \* Sentinel: [Replacements -> BOOLEAN] executions.lease_until is in the future
  att,        \* Sentinel: [Replacements -> 0..MaxAttempts] executions.attempts
  job,        \* worker: [Executors -> Replacements \cup {NoJob}]
  pc,         \* worker: [Executors -> PCs] where it is in executeReplacement
  mine        \* worker: [Executors -> 0..MaxAttempts] the attempt number its claim returned

vars == <<otr, hist, seen, origPay, tr, stray, pay, ex, leaseLive, att, job, pc, mine>>
envVars == <<otr, hist>>
sentinelVars == <<seen, origPay, tr, stray, pay, ex, leaseLive, att, job, pc, mine>>

TypeOK ==
  /\ otr \in OrigStates /\ hist \subseteq OrigStates /\ seen \subseteq hist
  /\ origPay \in {"dispatched", "failed_confirmed"}
  /\ tr \in [Replacements -> {"absent", "live"}] /\ stray \in [Replacements -> {"absent", "live"}]
  /\ pay \in [Replacements -> PayStates] /\ ex \in [Replacements -> ExecStates]
  /\ leaseLive \in [Replacements -> BOOLEAN] /\ att \in [Replacements -> 0..MaxAttempts]
  /\ job \in [Executors -> Replacements \cup {NoJob}] /\ pc \in [Executors -> PCs]
  /\ mine \in [Executors -> 0..MaxAttempts]

Init ==
  /\ otr = "in_flight" /\ hist = {"in_flight"} /\ seen = {"in_flight"}
  /\ origPay = "dispatched"
  /\ tr = [r \in Replacements |-> "absent"] /\ stray = [r \in Replacements |-> "absent"]
  /\ pay = [r \in Replacements |-> "none"] /\ ex = [r \in Replacements |-> "none"]
  /\ leaseLive = [r \in Replacements |-> FALSE] /\ att = [r \in Replacements |-> 0]
  /\ job = [e \in Executors |-> NoJob] /\ pc = [e \in Executors |-> "idle"]
  /\ mine = [e \in Executors |-> 0]

----------------------------------------------------------------------------
\* The fence: how many payments for the obligation block it.
BlockingCount(op, p) ==
  (IF op = "dispatched" THEN 1 ELSE 0) + Cardinality({r \in Replacements : p[r] \in Blocking})

\* A write that leaves payments as p is accepted by the database (else the transaction aborts).
IndexAllows(p) == ~On("unique_index") \/ BlockingCount(origPay, p) <= 1

\* classifyFinality(history) = CONFIRMED_FAILED (packages/policy/src/transfer-history.ts).
ConfirmedFailed(s) ==
  IF On("typed_failure") THEN "failed" \in s /\ "paid" \notin s
  ELSE TRUE   \* defect: e.g. a timeout or "deadline passed" treated as failure

----------------------------------------------------------------------------
\* Environment: Airwallex and the network.

ProviderMove(to) ==
  /\ \/ otr = "in_flight" /\ to \in {"paid", "failed"}
     \/ otr = "paid" /\ to = "failed"        \* late failure after PAID
     \/ otr = "failed" /\ to = "cancelled"   \* FAILED auto-cancels, losing the reason
  /\ otr' = to /\ hist' = hist \cup {to}
  /\ UNCHANGED sentinelVars

\* A webhook for any past status arrives (late, duplicated, reordered); one never sent never arrives.
Webhook(s) ==
  /\ s \in hist /\ seen' = seen \cup {s}
  /\ UNCHANGED <<envVars, origPay, tr, stray, pay, ex, leaseLive, att, job, pc, mine>>

Poll ==
  /\ seen' = seen \cup {otr}
  /\ UNCHANGED <<envVars, origPay, tr, stray, pay, ex, leaseLive, att, job, pc, mine>>

ExpireLease(r) ==
  /\ leaseLive[r] /\ leaseLive' = [leaseLive EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<envVars, seen, origPay, tr, stray, pay, ex, att, job, pc, mine>>

Crash(e) ==   \* a worker dies or is restarted; its lease is left to expire
  /\ job[e] # NoJob
  /\ job' = [job EXCEPT ![e] = NoJob] /\ pc' = [pc EXCEPT ![e] = "idle"] /\ mine' = [mine EXCEPT ![e] = 0]
  /\ UNCHANGED <<envVars, seen, origPay, tr, stray, pay, ex, leaseLive, att>>

----------------------------------------------------------------------------
\* Sentinel: finality, approval.

\* syncPaymentFinality: the original is confirmed failed, so its fence is released.
ConfirmOriginalFailure ==
  /\ origPay = "dispatched" /\ ConfirmedFailed(seen)
  /\ origPay' = "failed_confirmed"
  /\ UNCHANGED <<envVars, seen, tr, stray, pay, ex, leaseLive, att, job, pc, mine>>

\* decide() = REPLACE, a person approves, approveProposal inserts the replacement
\* payment and its PENDING execution in one transaction. A person may also propose
\* again later (e.g. after an escalation), which is why there can be several.
Approve(r) ==
  /\ pay[r] = "none"
  /\ origPay = "failed_confirmed" /\ ConfirmedFailed(seen)
  /\ LET p == [pay EXCEPT ![r] = "intended"] IN
       /\ IndexAllows(p)
       /\ (~On("locked_checks") \/ BlockingCount(origPay, pay) = 0)   \* decide(): otherBlockingPayments = 0, under the lock
       /\ pay' = p
  /\ ex' = [ex EXCEPT ![r] = "pending"]
  /\ UNCHANGED <<envVars, seen, origPay, tr, stray, leaseLive, att, job, pc, mine>>

----------------------------------------------------------------------------
\* Sentinel: executeReplacement (packages/db/src/execution.ts), one step per transaction / call.

Done(e) == job' = [job EXCEPT ![e] = NoJob] /\ pc' = [pc EXCEPT ![e] = "idle"] /\ mine' = [mine EXCEPT ![e] = 0]
Goto(e, l) == pc' = [pc EXCEPT ![e] = l] /\ UNCHANGED <<job, mine>>

\* 1. Claim: PENDING, or CLAIMED/UNCERTAIN with an expired lease. attempts += 1.
Claim(e, r) ==
  /\ job[e] = NoJob /\ att[r] < MaxAttempts
  /\ \/ ex[r] = "pending"
     \/ ex[r] \in {"claimed", "uncertain"} /\ (~leaseLive[r] \/ ~On("lease"))
  /\ ex' = [ex EXCEPT ![r] = "claimed"] /\ leaseLive' = [leaseLive EXCEPT ![r] = TRUE]
  /\ att' = [att EXCEPT ![r] = @ + 1]
  /\ job' = [job EXCEPT ![e] = r] /\ pc' = [pc EXCEPT ![e] = "claimed"] /\ mine' = [mine EXCEPT ![e] = att[r] + 1]
  /\ UNCHANGED <<envVars, seen, origPay, tr, stray, pay>>

NeedsLookup(e) == pay[job[e]] = "uncertain" \/ mine[e] > 1

\* Releasing the fence (BLOCKED or REJECTED). The implemented rule: only the sole
\* attempt may release; otherwise another attempt may still create the transfer, so the
\* payment stays blocking (UNCERTAIN) and a person is asked.
ReleaseOrHold(r) ==
  IF ~On("sole_attempt_release") \/ att[r] = 1
    THEN [pay EXCEPT ![r] = "not_sent"]
    ELSE [pay EXCEPT ![r] = IF @ \in {"intended", "uncertain"} THEN "uncertain" ELSE @]

\* finishSuccess: payments.state = DISPATCHED, execution SUCCEEDED (aborts if the index refuses).
FinishSuccess(e) ==
  LET r == job[e]  p == [pay EXCEPT ![r] = "dispatched"] IN
  /\ IF IndexAllows(p)
       THEN pay' = p /\ ex' = [ex EXCEPT ![r] = "succeeded"]
       ELSE UNCHANGED <<pay, ex>>                    \* transaction throws; nothing written
  /\ Done(e)
  /\ UNCHANGED <<envVars, seen, origPay, tr, stray, leaseLive, att>>

\* finishUncertain: keep blocking (only from INTENDED/UNCERTAIN), execution UNCERTAIN, short lease.
FinishUncertain(e) ==
  LET r == job[e] IN
  /\ pay' = [pay EXCEPT ![r] = IF @ \in {"intended", "uncertain"} THEN "uncertain" ELSE @]
  /\ ex' = [ex EXCEPT ![r] = "uncertain"] /\ leaseLive' = [leaseLive EXCEPT ![r] = TRUE]
  /\ Done(e)
  /\ UNCHANGED <<envVars, seen, origPay, tr, stray, att>>

\* 2. A previous attempt may have reached the provider: findTransferByRequestId.
LookupFound(e) ==
  /\ pc[e] = "claimed" /\ NeedsLookup(e) /\ On("lookup") /\ tr[job[e]] = "live"
  /\ FinishSuccess(e)

LookupNone(e) ==
  /\ pc[e] = "claimed" /\ NeedsLookup(e) /\ On("lookup") /\ tr[job[e]] = "absent"
  /\ Goto(e, "looked")
  /\ UNCHANGED <<envVars, seen, origPay, tr, stray, pay, ex, leaseLive, att>>

LookupError(e) ==
  /\ pc[e] = "claimed" /\ NeedsLookup(e) /\ On("lookup")
  /\ FinishUncertain(e)

ReadyToRevalidate(e) ==
  \/ pc[e] = "looked"
  \/ pc[e] = "claimed" /\ (~NeedsLookup(e) \/ ~On("lookup"))

\* 3. Re-validate: poll the original, then (in one transaction) re-check finality and policy.
RevalidateGo(e) ==
  /\ ReadyToRevalidate(e)
  /\ seen' = seen \cup {otr}
  /\ \/ ~On("revalidate")
     \/ /\ origPay = "failed_confirmed" /\ ConfirmedFailed(seen \cup {otr})
        /\ (~On("locked_checks") \/ \A q \in Replacements \ {job[e]} : pay[q] \notin Blocking)   \* decide(), under the lock
  /\ Goto(e, "go")
  /\ UNCHANGED <<envVars, origPay, tr, stray, pay, ex, leaseLive, att>>

\* Blocked: the original is no longer confirmed failed, or anything else failed (approval
\* expired, balance, beneficiary, incident state). Always possible.
RevalidateBlock(e) ==
  /\ ReadyToRevalidate(e)
  /\ seen' = seen \cup {otr}
  /\ pay' = ReleaseOrHold(job[e])
  /\ ex' = [ex EXCEPT ![job[e]] = "blocked"]
  /\ Done(e)
  /\ UNCHANGED <<envVars, origPay, tr, stray, leaseLive, att>>

\* 4. createTransfer. With a stable request_id the provider de-duplicates (assumption A2);
\* with the defence off, a retry is a different transfer.
Created(e) ==
  LET r == job[e] IN
  IF ~On("stable_request_id") /\ mine[e] > 1
    THEN tr' = tr /\ stray' = [stray EXCEPT ![r] = "live"]
    ELSE tr' = [tr EXCEPT ![r] = "live"] /\ stray' = stray

SendOk(e) ==
  /\ pc[e] = "go" /\ Created(e) /\ Goto(e, "sent_ok")
  /\ UNCHANGED <<envVars, seen, origPay, pay, ex, leaseLive, att>>

SendLostAfterCreate(e) ==   \* the provider created it; the response never came back
  /\ pc[e] = "go" /\ Created(e) /\ Goto(e, "sent_lost")
  /\ UNCHANGED <<envVars, seen, origPay, pay, ex, leaseLive, att>>

SendLostBeforeCreate(e) ==  \* timeout before the provider stored anything
  /\ pc[e] = "go" /\ Goto(e, "sent_lost")
  /\ UNCHANGED <<envVars, seen, origPay, tr, stray, pay, ex, leaseLive, att>>

\* A definite rejection: the provider holds no transfer under this request_id (assumption A3:
\* the adapter turns a duplicate-request_id error into the existing transfer, i.e. SendOk).
SendRejected(e) ==
  /\ pc[e] = "go" /\ tr[job[e]] = "absent" /\ Goto(e, "rejected")
  /\ UNCHANGED <<envVars, seen, origPay, tr, stray, pay, ex, leaseLive, att>>

\* 5. Record the outcome (its own transaction, possibly much later for a paused worker).
Finish(e) ==
  \/ pc[e] = "sent_ok" /\ FinishSuccess(e)
  \/ pc[e] = "sent_lost" /\ FinishUncertain(e)
  \/ /\ pc[e] = "rejected"
     /\ pay' = ReleaseOrHold(job[e]) /\ ex' = [ex EXCEPT ![job[e]] = "rejected"]
     /\ Done(e)
     /\ UNCHANGED <<envVars, seen, origPay, tr, stray, leaseLive, att>>

----------------------------------------------------------------------------
Next ==
  \/ \E to \in OrigStates : ProviderMove(to)
  \/ \E s \in OrigStates : Webhook(s)
  \/ Poll
  \/ ConfirmOriginalFailure
  \/ \E r \in Replacements : Approve(r) \/ ExpireLease(r)
  \/ \E e \in Executors :
       \/ Crash(e)
       \/ \E r \in Replacements : Claim(e, r)
       \/ LookupFound(e) \/ LookupNone(e) \/ LookupError(e)
       \/ RevalidateGo(e) \/ RevalidateBlock(e)
       \/ SendOk(e) \/ SendLostAfterCreate(e) \/ SendLostBeforeCreate(e) \/ SendRejected(e)
       \/ Finish(e)

Spec == Init /\ [][Next]_vars

Symmetry == Permutations(Executors) \cup Permutations(Replacements)

----------------------------------------------------------------------------
\* Safety.

LiveCount ==
  (IF otr \in Live THEN 1 ELSE 0)
  + Cardinality({r \in Replacements : tr[r] = "live"})
  + Cardinality({r \in Replacements : stray[r] = "live"})

\* THE property: at most one transfer for the obligation can deliver money.
NoDoublePayment == LiveCount <= 1

\* The stronger property that makes it hold: every transfer that can still move money
\* has a payment record that holds the obligation's fence.
FenceHeld ==
  /\ otr \in Live => origPay = "dispatched"
  /\ \A r \in Replacements : tr[r] = "live" => pay[r] \in Blocking
  /\ \A r \in Replacements : stray[r] = "absent"

\* The database never holds two blocking payments for one obligation.
AtMostOneBlocking == BlockingCount(origPay, pay) <= 1

----------------------------------------------------------------------------
\* Witnesses (checked as "this must be violated"): the interesting states are reachable,
\* so the properties above are not true merely because nothing happens.

NeverReplaced == ~\E r \in Replacements : tr[r] = "live" /\ pay[r] = "dispatched"
NeverTwoWorkersOnOneJob == ~\E e, f \in Executors : e # f /\ job[e] # NoJob /\ job[e] = job[f]
NeverHeldAfterBlock == ~\E r \in Replacements : ex[r] = "blocked" /\ pay[r] = "uncertain"
NeverLiveUnderUncertain == ~\E r \in Replacements : tr[r] = "live" /\ pay[r] = "uncertain"
=============================================================================
