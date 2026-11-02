import { formatMoney } from "../lib/format";
import type { CostEstimate } from "../lib/types";
import { Badge, Card, cx } from "./ui";

const pct = (bps: number) => `${Math.floor(bps / 100)}%`;

const NOT_AVAILABLE: Record<string, string> = {
  replacement_already_sent: "A replacement has been sent, so there is nothing left to compare.",
  no_original_payment: "No original payment is linked to this invoice.",
};

function unavailableText(reason: string): string {
  if (NOT_AVAILABLE[reason]) return NOT_AVAILABLE[reason];
  if (reason.startsWith("finality_not_estimable")) return "The original's fate is unknown (no provider record, a cancellation without a reason, or conflicting history). There is no honest number to show; a person must look.";
  if (reason.startsWith("no_priors_for_currency")) return `No priors are defined for ${reason.split(":")[1]}.`;
  return reason;
}

/** Advisory arrival and cost estimate. Policy decides; this only adds context. */
export function CostEstimateCard({ e, currency }: { e: CostEstimate; currency: string }) {
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Arrival and cost estimate <Badge tone="warn" title="Our own assumptions, written in code. Not measured Airwallex data and not a calibrated prediction.">{e.label}</Badge>
        </span>
      }
    >
      {!e.available ? (
        <p className="text-sm text-ink-dim">{unavailableText(e.reason)}</p>
      ) : (
        <div className="space-y-4 text-sm">
          <div>
            <p className="text-ink-faint">Chance the original arrives in the next {e.horizonHours} h</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{pct(e.originalArrivalBps)}</p>
            <p className="text-xs text-ink-faint">
              Range {pct(e.originalArrivalRangeBps.low)} to {pct(e.originalArrivalRangeBps.high)} if transfers are twice as slow or twice as fast
            </p>
          </div>
          <table className="w-full text-left">
            <caption className="sr-only">Expected cost of each action over the next {e.horizonHours} hours</caption>
            <thead className="text-xs text-ink-faint">
              <tr>
                <th scope="col" className="pb-1 font-normal">Action</th>
                <th scope="col" className="pb-1 text-right font-normal">Expected cost</th>
              </tr>
            </thead>
            <tbody>
              {e.costs.map((c) => (
                <tr key={c.action} className={cx("border-t border-line", c.action === e.cheapestAllowed && "text-ink")}>
                  <th scope="row" className="py-1.5 font-medium">
                    {c.action}
                    {c.action === e.cheapestAllowed && <span className="ml-2 text-xs font-normal text-ink-faint">lowest</span>}
                  </th>
                  <td className="py-1.5 text-right tabular-nums">
                    {c.allowed ? (
                      <span title={`Delay ${formatMoney(c.parts.delayMinor, currency)} · fees ${formatMoney(c.parts.feeMinor, currency)} · review ${formatMoney(c.parts.reviewMinor, currency)}`}>
                        {formatMoney(c.expectedCostMinor, currency)}
                      </span>
                    ) : (
                      <span className="text-danger">Forbidden by policy</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {e.policyRecommendation && e.policyRecommendation !== e.cheapestAllowed ? (
            <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              The estimate favours {e.cheapestAllowed}, but the policy recommendation stays {e.policyRecommendation}. Code decides; a person may still escalate by hand.
            </p>
          ) : (
            <p className="text-xs text-ink-faint">Agrees with the policy recommendation. The policy decides either way.</p>
          )}
          <p className="text-xs text-ink-faint">
            Assumes lateness costs {e.priors.delayCostBpsPerDay / 100}% of the amount per day overdue and a person acts within {e.priors.reviewDelayHours} h of an escalation. Priors {e.priorsVersion}.
          </p>
        </div>
      )}
    </Card>
  );
}
