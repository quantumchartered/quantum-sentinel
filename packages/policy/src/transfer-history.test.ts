import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EMPTY_HISTORY,
  type TransferObservation,
  applyObservation,
  classifyFinality,
  foldObservations,
} from "./transfer-history.js";

let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 27, 12, 0, clock++)).toISOString();

const obs = (rawStatus: string, over: Partial<TransferObservation> = {}): TransferObservation => ({
  source: "poll",
  eventId: null,
  rawStatus,
  observedAt: at(),
  failure: null,
  ...over,
});

const bankReturn = {
  code: null,
  message: "Returned by beneficiary bank",
  type: "BENEFICIARY_BANK_RETURNED",
  reasonCodes: [],
};
const failedWebhook = obs("FAILED", { source: "webhook", eventId: "evt-failed", failure: bankReturn });
const bareCancelPoll = obs("CANCELLED");

describe("FAILED flips to CANCELLED within seconds", () => {
  it("webhook captured the failure; the later bare CANCELLED poll does not erase it", () => {
    const h = foldObservations([obs("SENT"), failedWebhook, bareCancelPoll]);
    expect(h.status).toBe("CANCELLED");
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatchObject({ type: "BENEFICIARY_BANK_RETURNED", observedWithStatus: "FAILED", source: "webhook" });
    expect(classifyFinality(h)).toMatchObject({ kind: "CONFIRMED_FAILED" });
  });

  it("the bare CANCELLED arrives FIRST and the FAILED webhook later: same outcome, no regression", () => {
    const h = foldObservations([obs("SENT"), bareCancelPoll, failedWebhook]);
    expect(h.status).toBe("CANCELLED");
    expect(h.failures[0]?.type).toBe("BENEFICIARY_BANK_RETURNED");
    expect(h.conflicts).toEqual([]);
    expect(classifyFinality(h).kind).toBe("CONFIRMED_FAILED");
  });

  it("a slow poller that only ever saw CANCELLED cannot claim a confirmed failure", () => {
    const h = foldObservations([obs("SENT"), bareCancelPoll]);
    expect(classifyFinality(h)).toEqual({ kind: "CANCELLED_WITHOUT_REASON" });
  });
});

describe("ordering and duplication", () => {
  it("ignores duplicate webhook deliveries", () => {
    const h1 = foldObservations([obs("SENT"), failedWebhook]);
    expect(applyObservation(h1, failedWebhook)).toBe(h1);
  });

  it("a stale SENT poll after FAILED does not regress the status", () => {
    const h = foldObservations([failedWebhook, obs("SENT")]);
    expect(h.status).toBe("FAILED");
    expect(h.conflicts).toEqual([]);
  });

  it("SENT stays in flight; it is never failure evidence", () => {
    expect(classifyFinality(foldObservations([obs("PROCESSING"), obs("SENT")]))).toEqual({ kind: "IN_FLIGHT", status: "SENT" });
  });

  it("PAID is not final, and FAILED after PAID is escalated, not replaceable", () => {
    expect(classifyFinality(foldObservations([obs("SENT"), obs("PAID")])).kind).toBe("PAID_NOT_FINAL");
    const late = foldObservations([obs("SENT"), obs("PAID"), failedWebhook, bareCancelPoll]);
    expect(classifyFinality(late).kind).toBe("FAILED_AFTER_PAID");
  });

  it("unknown statuses are conflicts", () => {
    expect(classifyFinality(foldObservations([obs("SENT"), obs("RETURNED")])).kind).toBe("CONFLICT");
  });

  it("an earlier lifecycle state arriving late is recorded without regressing", () => {
    // APPROVAL_REJECTED -> IN_APPROVAL -> SCHEDULED -> CANCELLED is a documented path.
    const h = foldObservations([obs("CANCELLED"), obs("APPROVAL_REJECTED")]);
    expect(h.status).toBe("CANCELLED");
    expect(h.statusesSeen).toEqual(["CANCELLED", "APPROVAL_REJECTED"]);
    expect(h.conflicts).toEqual([]);
  });

  it("a PAID seen out of order still marks the transfer as once-paid", () => {
    const h = foldObservations([obs("SENT"), failedWebhook, obs("PAID")]);
    expect(h.status).toBe("FAILED");
    expect(classifyFinality(h).kind).toBe("FAILED_AFTER_PAID");
  });

  it("legacy and current failure shapes are both retained", () => {
    const legacy = obs("CANCELLED", { failure: { code: null, message: "simulation", type: null, reasonCodes: [] } });
    const h = foldObservations([obs("SENT"), failedWebhook, legacy]);
    expect(h.failures.map((f) => f.message)).toEqual(["Returned by beneficiary bank", "simulation"]);
  });
});

describe("properties", () => {
  const lifecycle = ["SCHEDULED", "PROCESSING", "SENT", "FAILED", "CANCELLED"] as const;

  it("any order and any duplication of deliveries keeps the captured failure and ends at CANCELLED", () => {
    const pool: TransferObservation[] = [
      ...lifecycle.map((s) => obs(s)),
      failedWebhook,
      obs("CANCELLED", { source: "webhook", eventId: "evt-cancel" }),
    ];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...pool), { minLength: 1, maxLength: 20 }), (extra) => {
        // The failed webhook is always delivered at least once, at some position.
        fc.pre(extra.includes(failedWebhook));
        const h = foldObservations(extra);
        expect(h.failures.some((f) => f.type === "BENEFICIARY_BANK_RETURNED")).toBe(true);
        expect(h.conflicts).toEqual([]);
        // The projection is the furthest status delivered, never an earlier one.
        const furthest = extra.some((o) => o.rawStatus === "CANCELLED") ? "CANCELLED" : "FAILED";
        expect(h.status).toBe(furthest);
        expect(classifyFinality(h).kind).toBe("CONFIRMED_FAILED");
      }),
    );
  });

  it("without any failure facts, no ordering ever yields CONFIRMED_FAILED", () => {
    const statuses = ["SCHEDULED", "PROCESSING", "SENT", "PAID", "FAILED", "CANCELLED", "OVERDUE"];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...statuses), { maxLength: 15 }), (seq) => {
        const h = foldObservations(seq.map((s) => obs(s)));
        expect(classifyFinality(h).kind).not.toBe("CONFIRMED_FAILED");
      }),
    );
  });

  it("the projected status never moves backwards", () => {
    const statuses = ["SCHEDULED", "PROCESSING", "SENT", "PAID", "FAILED", "CANCELLED"];
    const order = new Map(statuses.map((s, i) => [s, i]));
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...statuses), { maxLength: 15 }), (seq) => {
        let h = EMPTY_HISTORY;
        for (const s of seq) {
          const before = h.status;
          h = applyObservation(h, obs(s));
          if (before && h.status) expect(order.get(h.status)!).toBeGreaterThanOrEqual(order.get(before)!);
        }
      }),
    );
  });
});
