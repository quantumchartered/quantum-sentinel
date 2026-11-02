import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type DecisionInput, decide } from "./decide.js";
import { ESTIMATE_PRIORS, type EstimateInput, arrivalCdf, conditionalArrival, estimate } from "./estimate.js";
import type { Finality } from "./transfer-history.js";

const failed: Finality = {
  kind: "CONFIRMED_FAILED",
  failure: { code: null, message: "Returned", type: "BENEFICIARY_BANK_RETURNED", reasonCodes: [], observedWithStatus: "FAILED", firstSeenAt: "2026-10-27T12:00:00Z", source: "webhook" },
};
const sent: Finality = { kind: "IN_FLIGHT", status: "SENT" };

// Scenario A: $25,000, two days overdue, $1.50 fee.
const base: EstimateInput = {
  original: sent,
  hoursSinceSent: 1,
  hoursUntilDue: -48,
  amountMinor: 2_500_000n,
  currency: "USD",
  replacementFeeMinor: 150n,
  replacementAllowed: false,
};

const ok = (e: ReturnType<typeof estimate>) => {
  if (!e.available) throw new Error(`no estimate: ${e.reason}`);
  return e;
};
const cost = (e: ReturnType<typeof ok>, a: string) => e.costs.find((c) => c.action === a)!;

describe("arrival curve (illustrative priors)", () => {
  it("is a CDF: starts at 0, never decreases, never exceeds 100%", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 500 }), fc.integer({ min: 10, max: 400 }), (a, b, scale) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(arrivalCdf(0, scale)).toBe(0);
        expect(arrivalCdf(lo, scale)).toBeLessThanOrEqual(arrivalCdf(hi, scale));
        expect(arrivalCdf(hi, scale)).toBeLessThanOrEqual(10_000);
      }),
    );
  });

  it("matches the declared points", () => {
    for (const [h, p] of ESTIMATE_PRIORS.arrivalCdfBps) expect(arrivalCdf(h)).toBe(p);
  });

  it("conditional arrival stays within 0..100% and is 0 past the end of the curve", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 300 }), fc.integer({ min: 0, max: 300 }), (e, w) => {
        const p = conditionalArrival(e, w);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(10_000);
      }),
    );
    expect(conditionalArrival(200, 100)).toBe(0);
  });
});

describe("estimate (advisory; policy decides)", () => {
  it("Scenario A step 1: the original is in flight, so WAIT is cheapest and REPLACE is forbidden, not priced", () => {
    const e = ok(estimate(base));
    expect(e.label).toBe("ILLUSTRATIVE PRIORS");
    expect(e.cheapestAllowed).toBe("WAIT");
    expect(cost(e, "REPLACE")).toEqual({ action: "REPLACE", allowed: false, reason: "forbidden_by_policy" });
    expect(e.originalArrivalBps).toBeGreaterThan(9000);
    expect(e.originalArrivalRangeBps.low).toBeLessThanOrEqual(e.originalArrivalBps);
    expect(e.originalArrivalRangeBps.high).toBeGreaterThanOrEqual(e.originalArrivalBps);
  });

  it("Scenario A step 2: after a confirmed bank return the original cannot arrive, and REPLACE is cheapest", () => {
    const e = ok(estimate({ ...base, original: failed, replacementAllowed: true }));
    expect(e.originalArrivalBps).toBe(0);
    expect(e.cheapestAllowed).toBe("REPLACE");
    const w = cost(e, "WAIT");
    const r = cost(e, "REPLACE");
    if (!w.allowed || !r.allowed) throw new Error("expected priced");
    expect(r.expectedCostMinor).toBeLessThan(w.expectedCostMinor);
    expect(r.parts.feeMinor).toBeGreaterThanOrEqual(150n);
  });

  it("a transfer stuck far past the curve makes WAIT expensive, and the estimate points to a person, never to a resend", () => {
    const e = ok(estimate({ ...base, hoursSinceSent: 200 }));
    expect(e.originalArrivalBps).toBe(0);
    expect(e.cheapestAllowed).toBe("ESCALATE");
    // decide() still says WAIT: age alone is never proof of failure.
    expect(decide({ ...decisionBase, original: sent }).recommendation).toBe("WAIT");
  });

  it("the cost of waiting rises as the deadline gets closer or passes", () => {
    const waitAt = (hoursUntilDue: number) => {
      const c = cost(ok(estimate({ ...base, hoursUntilDue })), "WAIT");
      return c.allowed ? c.expectedCostMinor : -1n;
    };
    const far = cost(ok(estimate({ ...base, hoursUntilDue: 500 })), "WAIT");
    expect(far.allowed && far.parts.delayMinor).toBe(0n);
    expect(waitAt(24)).toBeLessThanOrEqual(waitAt(0));
    expect(waitAt(0)).toBeLessThan(waitAt(-48));
  });

  it("property: never prices or picks REPLACE when policy forbids it, and only ever picks an allowed action", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Finality>(sent, failed, { kind: "IN_FLIGHT", status: "PROCESSING" }, { kind: "PAID_NOT_FINAL" }),
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: -300, max: 300 }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 6n }),
        fc.boolean(),
        (original, hoursSinceSent, hoursUntilDue, amountMinor, replacementFeeMinor, replacementAllowed) => {
          const e = ok(estimate({ original, hoursSinceSent, hoursUntilDue, amountMinor, currency: "USD", replacementFeeMinor, replacementAllowed }));
          const r = cost(e, "REPLACE");
          if (!replacementAllowed) {
            expect(r.allowed).toBe(false);
            expect(e.cheapestAllowed).not.toBe("REPLACE");
          }
          expect(e.costs.find((c) => c.action === e.cheapestAllowed)!.allowed).toBe(true);
          for (const c of e.costs) if (c.allowed) expect(c.expectedCostMinor).toBeGreaterThanOrEqual(0n);
        },
      ),
    );
  });

  it.each<[Finality, number | null, string]>([
    [{ kind: "IN_FLIGHT", status: null }, null, "finality_not_estimable:IN_FLIGHT:no_record"],
    [{ kind: "CANCELLED_WITHOUT_REASON" }, 3, "finality_not_estimable:CANCELLED_WITHOUT_REASON"],
    [{ kind: "CONFLICT", conflicts: ["x"] }, 3, "finality_not_estimable:CONFLICT"],
    [{ kind: "FAILED_AFTER_PAID", failure: null }, 3, "finality_not_estimable:FAILED_AFTER_PAID"],
    [{ kind: "IN_FLIGHT", status: "SCHEDULED" }, null, "finality_not_estimable:IN_FLIGHT:SCHEDULED"],
  ])("gives no numbers when finality is unknown (%o)", (original, hoursSinceSent, reason) => {
    expect(estimate({ ...base, original, hoursSinceSent })).toMatchObject({ available: false, reason });
  });

  it("gives no numbers for a currency without priors", () => {
    expect(estimate({ ...base, currency: "EUR" })).toMatchObject({ available: false, reason: "no_priors_for_currency:EUR" });
  });
});

const decisionBase: DecisionInput = {
  original: failed,
  obligation: { amountMinor: 2_500_000n, currency: "USD", dueAt: "2026-10-25T00:00:00Z" },
  otherBlockingPayments: 0,
  availableMinor: 6_000_000n,
  replacementFeeMinor: 150n,
  reserveFloorMinor: 0n,
  riskFlags: [],
  now: "2026-10-27T12:00:00Z",
};
