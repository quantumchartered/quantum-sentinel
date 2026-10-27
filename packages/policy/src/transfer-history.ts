/**
 * Pure fold of everything we have observed about ONE provider transfer
 * (webhooks, backup polls, create responses). Pure code, no I/O.
 *
 * Guarantees (each has tests, including property tests):
 * - Failure facts are append-only. A later bare CANCELLED, a stale poll, or any
 *   reordering/duplication of deliveries can never erase a captured failure.
 * - The projected status only moves forward along the documented lifecycle.
 *   Older observations arriving late are recorded but do not regress it.
 * - Observations that fit no forward path (or unknown statuses) raise a
 *   conflict, which blocks any payment decision until reconciled.
 */

export type TransferStatus =
  | "IN_APPROVAL"
  | "APPROVAL_RECALLED"
  | "APPROVAL_REJECTED"
  | "APPROVAL_BLOCKED"
  | "SCHEDULED"
  | "OVERDUE"
  | "PROCESSING"
  | "SENT"
  | "PAID"
  | "FAILED"
  | "CANCELLED";

/** Documented lifecycle (Airwallex "Transfer statuses", API >= 2025-06-30). */
const NEXT: Record<TransferStatus, readonly TransferStatus[]> = {
  IN_APPROVAL: ["SCHEDULED", "APPROVAL_RECALLED", "APPROVAL_REJECTED", "APPROVAL_BLOCKED"],
  APPROVAL_RECALLED: ["IN_APPROVAL"],
  APPROVAL_REJECTED: ["IN_APPROVAL"],
  APPROVAL_BLOCKED: ["IN_APPROVAL"],
  SCHEDULED: ["PROCESSING", "OVERDUE", "CANCELLED"],
  OVERDUE: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SENT", "FAILED"],
  SENT: ["PAID", "FAILED"],
  PAID: ["FAILED"],
  FAILED: ["CANCELLED"],
  CANCELLED: [],
};

/** Statuses at which the transfer has left our wallet towards the beneficiary's bank. */
const DISPATCHED: ReadonlySet<TransferStatus> = new Set(["SENT", "PAID"]);

function reachable(from: TransferStatus, to: TransferStatus): boolean {
  const seen = new Set<TransferStatus>([from]);
  const stack = [...NEXT[from]];
  while (stack.length) {
    const s = stack.pop()!;
    if (s === to) return true;
    if (seen.has(s)) continue;
    seen.add(s);
    stack.push(...NEXT[s]);
  }
  return false;
}

export interface FailureFacts {
  code: string | null;
  message: string | null;
  type: string | null;
  reasonCodes: readonly string[];
}

export interface TransferObservation {
  source: "webhook" | "poll" | "create" | "reconcile";
  /** Provider event id for webhooks; used for deduplication. */
  eventId: string | null;
  /** Raw status as received. */
  rawStatus: string;
  /** When WE learned this (local clock, ISO 8601). */
  observedAt: string;
  failure: FailureFacts | null;
}

export interface CapturedFailure extends FailureFacts {
  /** Status the transfer had when this failure was observed (FAILED, CANCELLED, ...). */
  observedWithStatus: string;
  firstSeenAt: string;
  source: TransferObservation["source"];
}

export interface TransferHistory {
  observations: readonly TransferObservation[];
  /** Forward-only projection; null until a known status is seen. */
  status: TransferStatus | null;
  statusesSeen: readonly string[];
  /** Append-only; first time each distinct failure was seen. */
  failures: readonly CapturedFailure[];
  everDispatched: boolean;
  everPaid: boolean;
  /** Reasons the history cannot be trusted without reconciliation. */
  conflicts: readonly string[];
}

export const EMPTY_HISTORY: TransferHistory = {
  observations: [],
  status: null,
  statusesSeen: [],
  failures: [],
  everDispatched: false,
  everPaid: false,
  conflicts: [],
};

function isKnown(s: string): s is TransferStatus {
  return Object.prototype.hasOwnProperty.call(NEXT, s);
}

function failureKey(f: FailureFacts): string {
  return JSON.stringify([f.code, f.message, f.type, [...f.reasonCodes].sort()]);
}

export function observationDedupKey(o: TransferObservation): string {
  if (o.eventId) return `event:${o.eventId}`;
  return `snap:${o.source}:${o.rawStatus}:${o.failure ? failureKey(o.failure) : "-"}`;
}

function hasFacts(f: FailureFacts | null): f is FailureFacts {
  return !!f && !!(f.code || f.message || f.type || f.reasonCodes.length);
}

export function applyObservation(h: TransferHistory, o: TransferObservation): TransferHistory {
  const key = observationDedupKey(o);
  if (h.observations.some((x) => observationDedupKey(x) === key)) return h; // duplicate delivery

  const statusesSeen = h.statusesSeen.includes(o.rawStatus) ? h.statusesSeen : [...h.statusesSeen, o.rawStatus];
  let failures = h.failures;
  if (hasFacts(o.failure) && !failures.some((f) => failureKey(f) === failureKey(o.failure!))) {
    failures = [
      ...failures,
      { ...o.failure, reasonCodes: [...o.failure.reasonCodes], observedWithStatus: o.rawStatus, firstSeenAt: o.observedAt, source: o.source },
    ];
  }

  let status = h.status;
  let conflicts = h.conflicts;
  if (!isKnown(o.rawStatus)) {
    conflicts = [...conflicts, `unknown provider status ${o.rawStatus}`];
  } else if (status === null || status === o.rawStatus || reachable(status, o.rawStatus)) {
    status = o.rawStatus;
  } else if (!reachable(o.rawStatus, status)) {
    conflicts = [...conflicts, `status ${o.rawStatus} cannot follow ${status}`];
  } // else: a late/stale observation of an earlier state; recorded, no regression

  return {
    observations: [...h.observations, o],
    status,
    statusesSeen,
    failures,
    everDispatched: h.everDispatched || (isKnown(o.rawStatus) && DISPATCHED.has(o.rawStatus)),
    everPaid: h.everPaid || o.rawStatus === "PAID",
    conflicts,
  };
}

export function foldObservations(obs: readonly TransferObservation[], start: TransferHistory = EMPTY_HISTORY): TransferHistory {
  return obs.reduce(applyObservation, start);
}

/**
 * Finality classification used by the replacement policy. Deliberately
 * conservative: only a captured failure plus a terminal status counts.
 */
export type Finality =
  | { kind: "IN_FLIGHT"; status: TransferStatus | null }
  | { kind: "PAID_NOT_FINAL" }
  | { kind: "CONFIRMED_FAILED"; failure: CapturedFailure }
  | { kind: "CANCELLED_WITHOUT_REASON" }
  | { kind: "FAILED_AFTER_PAID"; failure: CapturedFailure | null }
  | { kind: "CONFLICT"; conflicts: readonly string[] };

export function classifyFinality(h: TransferHistory): Finality {
  if (h.conflicts.length) return { kind: "CONFLICT", conflicts: h.conflicts };
  const terminalFailure = h.status === "FAILED" || h.status === "CANCELLED";
  const failure = h.failures.at(-1) ?? null;
  if (terminalFailure && h.everPaid) return { kind: "FAILED_AFTER_PAID", failure };
  if (terminalFailure && failure) return { kind: "CONFIRMED_FAILED", failure };
  if (h.status === "CANCELLED") return { kind: "CANCELLED_WITHOUT_REASON" };
  if (h.status === "PAID") return { kind: "PAID_NOT_FINAL" };
  return { kind: "IN_FLIGHT", status: h.status };
}
