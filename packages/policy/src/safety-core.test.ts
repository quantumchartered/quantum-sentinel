import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ApprovalBinding, type CurrentFacts, signApproval, verifyApproval } from "./approval.js";
import { type AuditEntry, nextAuditEntry, verifyAuditChain } from "./audit-chain.js";
import { canonicalJson, evidenceSetHash } from "./canonical.js";
import { type DecisionInput, decide } from "./decide.js";
import { type IncidentEvent, type IncidentSnapshot, transitionIncident } from "./incident.js";
import type { Finality } from "./transfer-history.js";

const confirmedFailed: Finality = {
  kind: "CONFIRMED_FAILED",
  failure: {
    code: null,
    message: "Returned",
    type: "BENEFICIARY_BANK_RETURNED",
    reasonCodes: [],
    observedWithStatus: "FAILED",
    firstSeenAt: "2026-10-27T12:00:00Z",
    source: "webhook",
  },
};

const base: DecisionInput = {
  original: confirmedFailed,
  obligation: { amountMinor: 2_500_000n, currency: "USD", dueAt: "2026-10-25T00:00:00Z" },
  otherBlockingPayments: 0,
  availableMinor: 6_000_000n,
  replacementFeeMinor: 150n,
  reserveFloorMinor: 0n,
  riskFlags: [],
  now: "2026-10-27T12:00:00Z",
};

describe("decide (WAIT / REPLACE / ESCALATE)", () => {
  it("Scenario A step 1: SENT original -> WAIT, replacement forbidden even past the deadline", () => {
    const d = decide({ ...base, original: { kind: "IN_FLIGHT", status: "SENT" } });
    expect(d).toMatchObject({ recommendation: "WAIT", replacementAllowed: false });
    expect(d.reasons).toContain("deadline_passed_but_original_may_still_arrive");
  });

  it("Scenario A step 2: confirmed bank return + funds -> REPLACE", () => {
    expect(decide(base)).toMatchObject({ recommendation: "REPLACE", replacementAllowed: true });
  });

  it("Scenario C: a bank-detail change request escalates even when replacement would otherwise be allowed", () => {
    const d = decide({ ...base, riskFlags: ["BANK_DETAIL_CHANGE_REQUEST"] });
    expect(d).toMatchObject({ recommendation: "ESCALATE", replacementAllowed: false });
  });

  it("the decision changes when the balance changes", () => {
    const need = base.obligation.amountMinor + base.replacementFeeMinor;
    expect(decide({ ...base, availableMinor: need }).recommendation).toBe("REPLACE");
    expect(decide({ ...base, availableMinor: need - 1n })).toMatchObject({ recommendation: "ESCALATE" });
    expect(decide({ ...base, availableMinor: need, reserveFloorMinor: 1n }).recommendation).toBe("ESCALATE");
    expect(decide({ ...base, availableMinor: null }).reasons).toEqual(["balance:unavailable"]);
  });

  it.each<Finality["kind"]>(["CANCELLED_WITHOUT_REASON", "FAILED_AFTER_PAID", "CONFLICT"])("%s escalates", (kind) => {
    const original = (
      kind === "CONFLICT" ? { kind, conflicts: ["x"] } : kind === "FAILED_AFTER_PAID" ? { kind, failure: null } : { kind }
    ) as Finality;
    expect(decide({ ...base, original }).recommendation).toBe("ESCALATE");
  });

  it("a failure without a recorded type (e.g. bare 'simulation' reason) escalates", () => {
    const untyped: Finality = { kind: "CONFIRMED_FAILED", failure: { ...(confirmedFailed as Extract<Finality, { kind: "CONFIRMED_FAILED" }>).failure, type: null, message: "simulation" } };
    expect(decide({ ...base, original: untyped }).reasons).toEqual(["original:failure_type_missing"]);
  });

  it("another blocking payment escalates instead of replacing", () => {
    expect(decide({ ...base, otherBlockingPayments: 1 }).recommendation).toBe("ESCALATE");
  });

  it("property: REPLACE only ever with CONFIRMED_FAILED, no risk, no other payment, enough money", () => {
    const finalities: Finality[] = [
      confirmedFailed,
      { kind: "IN_FLIGHT", status: "SENT" },
      { kind: "IN_FLIGHT", status: null },
      { kind: "PAID_NOT_FINAL" },
      { kind: "CANCELLED_WITHOUT_REASON" },
      { kind: "FAILED_AFTER_PAID", failure: null },
      { kind: "CONFLICT", conflicts: ["c"] },
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...finalities),
        fc.nat(3),
        fc.option(fc.bigInt({ min: 0n, max: 10_000_000n }), { nil: null }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.bigInt({ min: 0n, max: 100_000n }),
        fc.subarray(["BANK_DETAIL_CHANGE_REQUEST", "PROMPT_INJECTION_SUSPECTED", "BENEFICIARY_MISMATCH", "EVIDENCE_CONFLICT"] as const),
        (original, other, available, fee, reserve, riskFlags) => {
          const d = decide({ ...base, original, otherBlockingPayments: other, availableMinor: available, replacementFeeMinor: fee, reserveFloorMinor: reserve, riskFlags });
          if (d.recommendation === "REPLACE") {
            expect(original.kind).toBe("CONFIRMED_FAILED");
            expect(riskFlags).toHaveLength(0);
            expect(other).toBe(0);
            expect(available! >= base.obligation.amountMinor + fee + reserve).toBe(true);
          }
          expect(d.replacementAllowed).toBe(d.recommendation === "REPLACE");
        },
      ),
    );
  });
});

describe("incident state machine", () => {
  const s0: IncidentSnapshot = { state: "OPEN", recommendation: null, version: 0 };
  const run = (events: IncidentEvent[], from = s0) =>
    events.reduce<IncidentSnapshot>((s, e) => {
      const r = transitionIncident(s, e);
      if (!r.ok) throw new Error(r.reason);
      return r.next;
    }, from);

  it("happy path WAIT -> new evidence -> REPLACE -> approve -> execute -> resolve", () => {
    const s = run([
      { type: "START_INVESTIGATION" },
      { type: "RECOMMEND", recommendation: "WAIT" },
      { type: "ACKNOWLEDGE_WAIT" },
      { type: "NEW_EVIDENCE" },
      { type: "RECOMMEND", recommendation: "REPLACE" },
      { type: "REQUEST_APPROVAL" },
      { type: "APPROVE" },
      { type: "DISPATCHED" },
      { type: "RESOLVE", originalFate: "RETURNED: BENEFICIARY_BANK_RETURNED", settledBy: "REPLACEMENT", openPaymentUncertainty: false },
    ]);
    expect(s).toMatchObject({ state: "RESOLVED", version: 9 });
  });

  it("never resolves just because the replacement is PAID: the original's fate is required", () => {
    const monitoring = run([{ type: "START_INVESTIGATION" }, { type: "RECOMMEND", recommendation: "WAIT" }, { type: "ACKNOWLEDGE_WAIT" }]);
    const r = transitionIncident(monitoring, { type: "RESOLVE", originalFate: null, settledBy: "REPLACEMENT", openPaymentUncertainty: false });
    expect(r).toEqual({ ok: false, reason: "cannot resolve: the original transfer's fate is not recorded" });
    expect(transitionIncident(monitoring, { type: "RESOLVE", originalFate: "x", settledBy: "REPLACEMENT", openPaymentUncertainty: true }).ok).toBe(false);
  });

  it("WAIT cannot be sent for payment approval", () => {
    const s = run([{ type: "START_INVESTIGATION" }, { type: "RECOMMEND", recommendation: "WAIT" }]);
    expect(transitionIncident(s, { type: "REQUEST_APPROVAL" }).ok).toBe(false);
  });

  it("new evidence during approval sends it back to investigation (version bump kills the approval)", () => {
    const s = run([{ type: "START_INVESTIGATION" }, { type: "RECOMMEND", recommendation: "REPLACE" }, { type: "REQUEST_APPROVAL" }]);
    const r = transitionIncident(s, { type: "NEW_EVIDENCE" });
    expect(r).toMatchObject({ ok: true, next: { state: "INVESTIGATING", recommendation: null, version: s.version + 1 } });
  });

  it("property: from any reachable state, random events never reach RESOLVED without the guards", () => {
    const events: IncidentEvent[] = [
      { type: "START_INVESTIGATION" },
      { type: "RECOMMEND", recommendation: "WAIT" },
      { type: "RECOMMEND", recommendation: "REPLACE" },
      { type: "RECOMMEND", recommendation: "ESCALATE" },
      { type: "REQUEST_APPROVAL" },
      { type: "ACKNOWLEDGE_WAIT" },
      { type: "APPROVE" },
      { type: "REJECT" },
      { type: "NEW_EVIDENCE" },
      { type: "DISPATCHED" },
      { type: "DISPATCH_UNCERTAIN" },
      { type: "RESOLVE", originalFate: null, settledBy: "REPLACEMENT", openPaymentUncertainty: false },
      { type: "RESOLVE", originalFate: "x", settledBy: null, openPaymentUncertainty: false },
      { type: "RESOLVE", originalFate: "x", settledBy: "ORIGINAL", openPaymentUncertainty: true },
      { type: "ESCALATE", reason: "r" },
      { type: "REOPEN", reason: "r" },
    ];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...events), { maxLength: 40 }), (seq) => {
        let s = s0;
        let lastVersion = 0;
        for (const e of seq) {
          const r = transitionIncident(s, e);
          if (r.ok) {
            s = r.next;
            expect(s.version).toBe(lastVersion + 1);
            lastVersion = s.version;
          }
          expect(s.state).not.toBe("RESOLVED");
          // EXECUTING is only reachable through APPROVE of a REPLACE recommendation.
          if (s.state === "EXECUTING") expect(s.recommendation).toBe("REPLACE");
        }
      }),
    );
  });
});

describe("bound approvals", () => {
  const SECRET = "x".repeat(32);
  const binding: ApprovalBinding = {
    organizationId: "org-1",
    incidentId: "inc-1",
    incidentVersion: 5,
    actionType: "REPLACE",
    amountMinor: 2_500_000n,
    currency: "USD",
    beneficiaryId: "ben-1",
    beneficiaryHash: "b".repeat(64),
    originalPaymentId: "pay-1",
    providerStateVersion: 4,
    evidenceSetHash: evidenceSetHash([{ id: "ev-1", contentHash: "h1" }]),
    policyVersion: "p1",
    approverId: "user-approver",
    nonce: "n-1",
    issuedAt: 1_000,
    expiresAt: 1_000 + 15 * 60_000,
  };
  const { approverId: _a, nonce: _n, issuedAt: _i, expiresAt: _e, ...facts } = binding;
  const current: CurrentFacts = facts;
  const signed = signApproval(SECRET, "k1", binding);

  it("verifies when nothing changed", () => {
    expect(verifyApproval({ k1: SECRET }, signed, current, 2_000)).toEqual({ ok: true });
  });

  it.each([
    ["amountMinor", 2_500_001n],
    ["currency", "EUR"],
    ["beneficiaryId", "ben-attacker"],
    ["beneficiaryHash", "c".repeat(64)],
    ["evidenceSetHash", "d".repeat(64)],
    ["providerStateVersion", 5],
    ["incidentVersion", 6],
    ["originalPaymentId", "pay-2"],
  ] as const)("any change to %s invalidates it", (field, value) => {
    const r = verifyApproval({ k1: SECRET }, signed, { ...current, [field]: value }, 2_000);
    expect(r).toEqual({ ok: false, reasons: [`changed:${field}`] });
  });

  it("expires after 15 minutes", () => {
    expect(verifyApproval({ k1: SECRET }, signed, current, binding.expiresAt)).toMatchObject({ ok: false, reasons: ["expired"] });
  });

  it("a tampered binding or forged signature fails", () => {
    const tampered = { ...signed, binding: { ...binding, amountMinor: 1n } };
    expect(verifyApproval({ k1: SECRET }, tampered, { ...current, amountMinor: 1n }, 2_000)).toMatchObject({ reasons: ["bad_signature"] });
    expect(verifyApproval({ k1: SECRET }, { ...signed, signature: "0".repeat(64) }, current, 2_000)).toMatchObject({ reasons: ["bad_signature"] });
    expect(verifyApproval({ k2: SECRET }, signed, current, 2_000)).toMatchObject({ reasons: ["unknown_key_version"] });
  });

  it("refuses weak secrets", () => {
    expect(() => signApproval("short", "k1", binding)).toThrow();
  });
});

describe("audit hash chain", () => {
  const build = (n: number) => {
    const out: AuditEntry[] = [];
    for (let i = 0; i < n; i++) {
      out.push(
        nextAuditEntry(out.at(-1) ?? null, {
          organizationId: "org-1",
          occurredAt: `2026-10-27T12:00:${String(i).padStart(2, "0")}Z`,
          actor: i % 2 ? "system" : "user-1",
          eventType: "incident.transition",
          payload: { i, amountMinor: 2_500_000n },
        }),
      );
    }
    return out;
  };

  it("verifies an intact chain", () => {
    expect(verifyAuditChain(build(5))).toMatchObject({ ok: true, entries: 5 });
  });

  it("detects an edited payload, a deleted entry and a reordering", () => {
    const edited = build(5);
    edited[2] = { ...edited[2]!, payload: { i: 2, amountMinor: 1n } };
    expect(verifyAuditChain(edited)).toMatchObject({ ok: false, brokenAtSeq: 3 });

    const deleted = build(5);
    deleted.splice(1, 1);
    expect(verifyAuditChain(deleted)).toMatchObject({ ok: false });

    const swapped = build(5);
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    expect(verifyAuditChain(swapped)).toMatchObject({ ok: false });
  });

  it("property: changing any single entry's actor is always detected", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9 }), fc.string({ minLength: 1 }), (idx, actor) => {
        const chain = build(10);
        fc.pre(chain[idx]!.actor !== actor);
        chain[idx] = { ...chain[idx]!, actor };
        expect(verifyAuditChain(chain).ok).toBe(false);
      }),
    );
  });
});

describe("canonical JSON", () => {
  it("is key-order independent and keeps bigint exact", () => {
    expect(canonicalJson({ b: 1, a: [2n, "x"] })).toBe(canonicalJson({ a: [2n, "x"], b: 1 }));
    expect(canonicalJson({ a: 2n })).not.toBe(canonicalJson({ a: "2" }));
    expect(canonicalJson({ a: 2n ** 70n })).toContain("1180591620717411303424n");
  });

  it("evidence-set hash ignores order but not content", () => {
    const a = [{ id: "1", contentHash: "x" }, { id: "2", contentHash: "y" }];
    expect(evidenceSetHash(a)).toBe(evidenceSetHash([...a].reverse()));
    expect(evidenceSetHash(a)).not.toBe(evidenceSetHash([{ id: "1", contentHash: "x" }]));
  });
});

describe("failure-type classes and missing records (policy-2026-11-02.1)", () => {
  const failedWith = (type: string): Finality => ({
    kind: "CONFIRMED_FAILED",
    failure: { code: null, message: null, type, reasonCodes: [], observedWithStatus: "FAILED", firstSeenAt: "2026-11-02T00:00:00Z", source: "webhook" },
  });

  it.each(["BENEFICIARY_BANK_RETURNED", "CHANNEL_TIMEOUT", "SYSTEM_ERROR", "INSUFFICIENT_FUNDS"])("%s can be replaced", (t) => {
    expect(decide({ ...base, original: failedWith(t) }).recommendation).toBe("REPLACE");
  });

  it.each([
    "ACCOUNT_CLOSED",
    "INVALID_ACCOUNT_NAME_OR_NUMBER",
    "BENEFICIARY_NAME_MISMATCH",
    "RECALL_REQUESTED",
    "CLIENT_REQUESTED",
    "DUPLICATION_RETURN",
    "TM_SUSPENDED",
    "TRANSACTION_AMOUNT_NOT_COVERING_FEE",
    "OTHER",
    "SOMETHING_UNDOCUMENTED",
  ])("%s escalates instead of re-sending to the same details", (t) => {
    expect(decide({ ...base, original: failedWith(t) })).toMatchObject({ recommendation: "ESCALATE", reasons: [`original:failure_requires_review:${t}`] });
  });

  it("no provider record at all escalates rather than waiting", () => {
    expect(decide({ ...base, original: { kind: "IN_FLIGHT", status: null } })).toMatchObject({ recommendation: "ESCALATE", reasons: ["original:no_provider_record"] });
  });
});
