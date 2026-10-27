import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

describe("redact", () => {
  it("masks bank identifiers, tokens and contact details at any depth", () => {
    const out = redact({
      token: "eyJ...",
      items: [{ id: "ga-1", account_number: "87535504221", routing_codes: [{ type: "aba", value: "021000021" }] }],
      beneficiary: { bank_details: { account_routing_value1: "021000021", iban: "GB81", account_name: "Demo Supplier" } },
      additional_info: { personal_email: "a@b.c" },
    });
    expect(JSON.stringify(out)).not.toMatch(/87535504221|021000021|eyJ|GB81|a@b\.c/);
    expect(out.items[0]!.id).toBe("ga-1");
    expect(out.beneficiary.bank_details.account_name).toBe("Demo Supplier");
  });

  it("leaves amounts, statuses and ids intact", () => {
    const t = { id: "t1", status: "FAILED", transfer_amount: 25000, failure: { details: { type: "BENEFICIARY_BANK_RETURNED" } } };
    expect(redact(t)).toEqual(t);
  });
});
