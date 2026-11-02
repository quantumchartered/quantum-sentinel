import type { Finality } from "./transfer-history.js";

/**
 * Arrival-probability and expected-cost estimate (AGENTS.md §5, T4).
 *
 * ADVISORY ONLY. `decide()` alone decides what is allowed; this never feeds it,
 * and a replacement the policy forbids has no cost here, only "forbidden".
 * The priors below are ILLUSTRATIVE assumptions written by us, not measured
 * Airwallex data and not a calibrated prediction. Everything is integer maths:
 * probabilities in basis points (0-10000), money in minor units (bigint).
 */

export const ESTIMATE_PRIORS = {
  version: "priors-illustrative-2026-11-02",
  label: "ILLUSTRATIVE PRIORS",
  rail: "LOCAL",
  /**
   * Chance (bps) that a SENT local transfer has reached the beneficiary after N
   * hours. Piecewise linear, flat after the last point. The missing 400 bps is
   * the assumed share that never arrives without someone intervening (returns).
   */
  arrivalCdfBps: [
    [0, 0],
    [6, 2500],
    [24, 7000],
    [48, 8800],
    [72, 9400],
    [120, 9600],
  ] as ReadonlyArray<readonly [hours: number, bps: number]>,
  /** Cost of paying late, per day past the due date, as bps of the amount. */
  delayCostBpsPerDay: 10,
  /** Operator time for an escalation, per currency (minor units). */
  reviewCostMinor: { USD: 7_500n } as Readonly<Record<string, bigint>>,
  /** How long a person takes to act on an escalation. */
  reviewDelayHours: 8,
  /**
   * Window the costs are compared over. Money still missing at the end is assumed to
   * go to a person anyway: it is charged a review, a new fee, and the lateness of a new
   * transfer sent at the window end.
   */
  horizonHours: 72,
  /** Sensitivity: the arrival curve stretched (slower) and compressed (faster). Percent of the base time scale. */
  sensitivityTimeScalePct: { slower: 200, faster: 50 },
} as const;

export type EstimatePriors = typeof ESTIMATE_PRIORS;
export type EstimateAction = "WAIT" | "REPLACE" | "ESCALATE";

export interface EstimateInput {
  original: Finality;
  /** Hours since the original was first seen SENT (or PROCESSING). null = never seen dispatched. */
  hoursSinceSent: number | null;
  /** Hours until the obligation's due date; negative when already overdue. */
  hoursUntilDue: number;
  amountMinor: bigint;
  currency: string;
  replacementFeeMinor: bigint;
  /** From decide(): whether policy allows a replacement right now. */
  replacementAllowed: boolean;
}

export type ActionCost =
  | { action: EstimateAction; allowed: true; expectedCostMinor: bigint; parts: { feeMinor: bigint; delayMinor: bigint; reviewMinor: bigint } }
  | { action: EstimateAction; allowed: false; reason: string };

export type Estimate =
  | { available: false; reason: string; priorsVersion: string; label: string }
  | {
      available: true;
      priorsVersion: string;
      label: string;
      horizonHours: number;
      /** Chance the ORIGINAL arrives within the horizon, given it has not arrived yet. */
      originalArrivalBps: number;
      /** The same chance under the slower and faster curves (min and max of the three). */
      originalArrivalRangeBps: { low: number; high: number };
      costs: ActionCost[];
      /** Cheapest action among those policy allows. Never one it forbids. */
      cheapestAllowed: EstimateAction;
    };

const BPS = 10_000;

/** Piecewise-linear CDF in bps at `hours`, with the time axis scaled by `scalePct`. */
export function arrivalCdf(hours: number, scalePct = 100, curve = ESTIMATE_PRIORS.arrivalCdfBps): number {
  if (hours <= 0) return 0;
  const h = (hours * 100) / scalePct;
  for (let i = 1; i < curve.length; i++) {
    const [h1, p1] = curve[i]!;
    const [h0, p0] = curve[i - 1]!;
    if (h <= h1) return Math.floor(p0 + ((p1 - p0) * (h - h0)) / (h1 - h0));
  }
  return curve.at(-1)![1];
}

/** P(arrives within `window` more hours | not arrived after `elapsed` hours), in bps. */
export function conditionalArrival(elapsed: number, window: number, scalePct = 100): number {
  const f0 = arrivalCdf(elapsed, scalePct);
  if (f0 >= BPS) return BPS;
  return Math.floor(((arrivalCdf(elapsed + window, scalePct) - f0) * BPS) / (BPS - f0));
}

/** Cumulative chance (bps) that the money has arrived t hours from now. */
type Cum = (t: number) => number;

/** Mean hours for a new transfer to arrive, given it arrives within the curve. */
export function meanArrivalHours(curve = ESTIMATE_PRIORS.arrivalCdfBps): number {
  const end = curve.at(-1)!;
  let sum = 0;
  for (let t = 1; t <= end[0]; t++) sum += (arrivalCdf(t) - arrivalCdf(t - 1)) * t;
  return Math.round(sum / end[1]);
}

/**
 * Late-hours mass (bps x hours) for money that arrives along `cum`, on an hourly
 * grid over (from, to]. With `tailHours`, money still missing at `to` is charged
 * as arriving `tailHours` after `to`.
 */
function lateMass(cum: Cum, from: number, to: number, hoursUntilDue: number, tailHours: number | null): { mass: bigint; arrived: number } {
  const late = (t: number) => BigInt(Math.max(0, t - hoursUntilDue));
  let mass = 0n;
  let arrived = cum(from);
  for (let t = from + 1; t <= to; t++) {
    const c = cum(t);
    mass += BigInt(c - arrived) * late(t);
    arrived = c;
  }
  if (tailHours !== null) mass += BigInt(BPS - arrived) * late(to + tailHours);
  return { mass, arrived };
}

export function estimate(input: EstimateInput, priors: EstimatePriors = ESTIMATE_PRIORS): Estimate {
  const meta = { priorsVersion: priors.version, label: priors.label };
  const review = priors.reviewCostMinor[input.currency];
  if (review === undefined) return { available: false, reason: `no_priors_for_currency:${input.currency}`, ...meta };

  const o = input.original;
  // Which curve the original is on. Only these states have one; everything else is a question for a person.
  let originalMode: "in_flight" | "arrived" | "failed";
  if (o.kind === "CONFIRMED_FAILED") originalMode = "failed";
  else if (o.kind === "PAID_NOT_FINAL") originalMode = "arrived";
  else if (o.kind === "IN_FLIGHT" && (o.status === "SENT" || o.status === "PROCESSING") && input.hoursSinceSent !== null) originalMode = "in_flight";
  else return { available: false, reason: `finality_not_estimable:${o.kind}${o.kind === "IN_FLIGHT" ? `:${o.status ?? "no_record"}` : ""}`, ...meta };

  const H = priors.horizonHours;
  const R = priors.reviewDelayHours;
  const due = input.hoursUntilDue;
  const elapsed = Math.max(0, input.hoursSinceSent ?? 0);
  const dailyCostMinor = (input.amountMinor * BigInt(priors.delayCostBpsPerDay)) / BigInt(BPS);
  const toMinor = (mass: bigint) => (mass * dailyCostMinor) / (BigInt(BPS) * 24n);
  const tail = meanArrivalHours();
  /** Share (bps) of money missing at the horizon pays a review and a new fee. */
  const share = (missingBps: number, minor: bigint) => (BigInt(missingBps) * minor) / BigInt(BPS);

  const originalCum =
    (scalePct: number): Cum =>
    (t) =>
      originalMode === "arrived" ? BPS : originalMode === "failed" ? 0 : conditionalArrival(elapsed, t, scalePct);
  /** A new transfer sent `at` hours from now. */
  const freshCum =
    (at: number): Cum =>
    (t) =>
      t <= at ? 0 : conditionalArrival(0, t - at);

  // WAIT: only the original can arrive.
  const wait = lateMass(originalCum(100), 0, H, due, tail);
  const waitCost = priced("WAIT", { feeMinor: share(BPS - wait.arrived, input.replacementFeeMinor), delayMinor: toMinor(wait.mass), reviewMinor: share(BPS - wait.arrived, review) });

  // ESCALATE: the original keeps its odds until a person acts after R hours. Whatever has
  // not arrived by then is assumed resolved by that person (trace, recall, re-send under a
  // fresh approval), modelled as a new transfer at R. An assumption, not a policy permission.
  const first = lateMass(originalCum(100), 0, R, due, null);
  const rest = lateMass(freshCum(R), R, H, due, tail);
  const unresolved = BPS - first.arrived;
  const restMissing = Math.floor((unresolved * (BPS - rest.arrived)) / BPS);
  const escalateCost = priced("ESCALATE", {
    feeMinor: share(unresolved, input.replacementFeeMinor) + share(restMissing, input.replacementFeeMinor),
    delayMinor: toMinor(first.mass + (BigInt(unresolved) * rest.mass) / BigInt(BPS)),
    reviewMinor: review + share(restMissing, review),
  });

  // REPLACE: priced only when policy allows it right now.
  let replaceCost: ActionCost;
  if (!input.replacementAllowed) {
    replaceCost = { action: "REPLACE", allowed: false, reason: "forbidden_by_policy" };
  } else {
    const r = lateMass(freshCum(0), 0, H, due, tail);
    const missing = BPS - r.arrived;
    replaceCost = priced("REPLACE", { feeMinor: input.replacementFeeMinor + share(missing, input.replacementFeeMinor), delayMinor: toMinor(r.mass), reviewMinor: share(missing, review) });
  }

  const originalArrival = (scalePct: number) => originalCum(scalePct)(H);
  const costs = [waitCost, replaceCost, escalateCost];
  // Ties go to the more conservative action: WAIT, then ESCALATE, then REPLACE.
  const order: EstimateAction[] = ["WAIT", "ESCALATE", "REPLACE"];
  const allowed = costs.filter((c): c is Extract<ActionCost, { allowed: true }> => c.allowed);
  allowed.sort((a, b) => (a.expectedCostMinor < b.expectedCostMinor ? -1 : a.expectedCostMinor > b.expectedCostMinor ? 1 : order.indexOf(a.action) - order.indexOf(b.action)));

  const range = [originalArrival(100), originalArrival(priors.sensitivityTimeScalePct.slower), originalArrival(priors.sensitivityTimeScalePct.faster)];
  return {
    available: true,
    ...meta,
    horizonHours: H,
    originalArrivalBps: range[0]!,
    originalArrivalRangeBps: { low: Math.min(...range), high: Math.max(...range) },
    costs,
    cheapestAllowed: allowed[0]!.action,
  };
}

function priced(action: EstimateAction, parts: { feeMinor: bigint; delayMinor: bigint; reviewMinor: bigint }): ActionCost {
  return { action, allowed: true, expectedCostMinor: parts.feeMinor + parts.delayMinor + parts.reviewMinor, parts };
}
