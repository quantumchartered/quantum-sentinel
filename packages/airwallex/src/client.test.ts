import { describe, expect, it } from "vitest";
import { money } from "@sentinel/contracts";
import { AirwallexClient, newRequestId, normalizeTransfer } from "./client.js";
import {
  AirwallexApiError,
  AirwallexConfigError,
  AirwallexContractError,
  AirwallexUncertainOutcomeError,
} from "./errors.js";
import { AirwallexHttp } from "./http.js";
import { TransferSchema } from "./schemas.js";
import { AirwallexSimulation } from "./simulation.js";

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
}
type Reply = { status: number; json?: unknown } | Error;

const SECRET = "sk_test_never_log_me";
const BASE = "https://api.sandbox.airwallex.com";
const T0 = Date.parse("2026-10-27T12:00:00Z");

/** A scripted fake Airwallex. `route` answers everything except login. */
function fakeAirwallex(route: (c: Call, n: number) => Reply, opts: { tokenTtlMs?: number } = {}) {
  const calls: Call[] = [];
  let clock = T0;
  let logins = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      method: String(init.method),
      path: u.pathname + u.search,
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    };
    calls.push(call);
    let reply: Reply;
    if (u.pathname === "/api/v1/authentication/login") {
      logins++;
      reply = {
        status: 201,
        json: { token: `tok${logins}`, expires_at: new Date(clock + (opts.tokenTtlMs ?? 30 * 60_000)).toISOString() },
      };
    } else {
      reply = route(call, calls.filter((c) => c.path === call.path).length);
    }
    if (reply instanceof Error) throw reply;
    return new Response(reply.json === undefined ? "" : JSON.stringify(reply.json), { status: reply.status });
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const http = new AirwallexHttp({
    clientId: "client_x",
    apiKey: SECRET,
    apiVersion: "2026-08-21",
    fetch: fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return {
    client: new AirwallexClient(http),
    calls,
    sleeps,
    logins: () => logins,
    advance: (ms: number) => (clock += ms),
    nonLogin: () => calls.filter((c) => !c.path.startsWith("/api/v1/authentication")),
  };
}

const transfer = (over: Record<string, unknown> = {}) => ({
  id: "4f1a7f0e-0000-4000-8000-000000000001",
  request_id: "req-original-0001",
  status: "SENT",
  transfer_amount: 25000,
  transfer_currency: "USD",
  source_currency: "USD",
  fee_amount: 1.5,
  fee_currency: "USD",
  beneficiary_id: "ben-1",
  updated_at: "2026-10-27T12:00:00+0000",
  ...over,
});

const createInput = (requestId = "req-replacement-0001") => ({
  requestId,
  beneficiaryId: "ben-1",
  amount: money(2_500_000n, "USD"),
  sourceCurrency: "USD" as const,
  transferMethod: "LOCAL" as const,
  reason: "goods_purchased",
  reference: "INV-1042",
});

describe("configuration guard", () => {
  it("refuses any base URL other than the sandbox", () => {
    for (const baseUrl of ["https://api.airwallex.com", "http://api.sandbox.airwallex.com", "https://evil.example"]) {
      expect(() => new AirwallexHttp({ clientId: "a", apiKey: "b", baseUrl })).toThrow(AirwallexConfigError);
    }
    expect(new AirwallexHttp({ clientId: "a", apiKey: "b", baseUrl: `${BASE}/` }).baseUrl).toBe(BASE);
  });

  it("requires credentials", () => {
    expect(() => new AirwallexHttp({ clientId: "", apiKey: "b" })).toThrow(AirwallexConfigError);
  });
});

describe("authentication", () => {
  it("logs in with x-client-id / x-api-key and no body, then sends the bearer token and api version", async () => {
    const f = fakeAirwallex(() => ({ status: 200, json: transfer() }));
    await f.client.getTransfer("t1");
    const [login, get] = f.calls;
    expect(login!.method).toBe("POST");
    expect(login!.headers["x-client-id"]).toBe("client_x");
    expect(login!.headers["x-api-key"]).toBe(SECRET);
    expect(login!.body).toBeUndefined();
    expect(get!.headers.authorization).toBe("Bearer tok1");
    expect(get!.headers["x-api-version"]).toBe("2026-08-21");
    expect(get!.headers["x-api-key"]).toBeUndefined();
  });

  it("shares one login across concurrent requests", async () => {
    const f = fakeAirwallex(() => ({ status: 200, json: transfer() }));
    await Promise.all([f.client.getTransfer("a"), f.client.getTransfer("b"), f.client.getTransfer("c")]);
    expect(f.logins()).toBe(1);
  });

  it("refreshes before expiry (30 min token, 5 min skew)", async () => {
    const f = fakeAirwallex(() => ({ status: 200, json: transfer() }));
    await f.client.getTransfer("a");
    f.advance(24 * 60_000);
    await f.client.getTransfer("a");
    expect(f.logins()).toBe(1);
    f.advance(2 * 60_000); // now inside the skew window
    await f.client.getTransfer("a");
    expect(f.logins()).toBe(2);
  });

  it("re-logs in once on 401 and retries the request", async () => {
    const f = fakeAirwallex((_c, n) => (n === 1 ? { status: 401, json: { code: "credentials_expired" } } : { status: 200, json: transfer() }));
    await expect(f.client.getTransfer("a")).resolves.toMatchObject({ status: "SENT" });
    expect(f.logins()).toBe(2);
  });

  it("never puts the API key in error messages", async () => {
    const f = fakeAirwallex(() => ({ status: 400, json: { code: "invalid_argument", message: "bad" } }));
    const err = await f.client.getTransfer("a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AirwallexApiError);
    expect(String((err as Error).message)).not.toContain(SECRET);
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });
});

describe("reads", () => {
  it("retries 503 with backoff then succeeds", async () => {
    const f = fakeAirwallex((_c, n) => (n < 3 ? { status: 503 } : { status: 200, json: transfer() }));
    await expect(f.client.getTransfer("a")).resolves.toMatchObject({ providerTransferId: transfer().id });
    expect(f.sleeps).toEqual([250, 500]);
  });

  it("does not retry a 404", async () => {
    const f = fakeAirwallex(() => ({ status: 404, json: { code: "not_found" } }));
    await expect(f.client.getTransfer("a")).rejects.toBeInstanceOf(AirwallexApiError);
    expect(f.nonLogin()).toHaveLength(1);
  });

  it("fails closed on a response that breaks the contract", async () => {
    const f = fakeAirwallex(() => ({ status: 200, json: { id: "x" } }));
    await expect(f.client.getTransfer("a")).rejects.toBeInstanceOf(AirwallexContractError);
  });

  it("converts balances to minor units and ignores unknown currencies", async () => {
    const f = fakeAirwallex(() => ({
      status: 200,
      json: [
        { account_type: "cash", currency: "USD", available_amount: 50025.5, pending_amount: 0, reserved_amount: 12.85 },
        { account_type: "cash", currency: "XAU", available_amount: 1 },
      ],
    }));
    await expect(f.client.getCurrentBalances()).resolves.toEqual([
      { currency: "USD", availableMinor: 5_002_550n, pendingMinor: 0n, reservedMinor: 1285n },
    ]);
    expect(f.nonLogin()[0]!.path).toBe("/api/v1/balances/current?account_type=cash");
  });
});

describe("createTransfer", () => {
  it("sends major units as a decimal string with the caller's request_id", async () => {
    const f = fakeAirwallex(() => ({ status: 201, json: transfer({ request_id: "req-replacement-0001", status: "SCHEDULED" }) }));
    const res = await f.client.createTransfer(createInput());
    expect(JSON.parse(f.nonLogin()[0]!.body!)).toEqual({
      request_id: "req-replacement-0001",
      beneficiary_id: "ben-1",
      transfer_amount: "25000.00",
      transfer_currency: "USD",
      source_currency: "USD",
      transfer_method: "LOCAL",
      reason: "goods_purchased",
      reference: "INV-1042",
    });
    expect(res).toMatchObject({ reconciled: false, transfer: { amount: { amountMinor: 2_500_000n } } });
  });

  it("retries a 5xx with byte-identical body and the same request_id", async () => {
    const f = fakeAirwallex((c, n) =>
      c.path.startsWith("/api/v1/transfers/create") && n === 1
        ? { status: 502 }
        : { status: 201, json: transfer({ request_id: "req-replacement-0001" }) },
    );
    await f.client.createTransfer(createInput());
    const posts = f.nonLogin();
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toBe(posts[1]!.body);
  });

  it("reconciles a duplicate_request_id to the existing matching transfer", async () => {
    const f = fakeAirwallex((c) =>
      c.method === "POST"
        ? { status: 400, json: { code: "duplicate_request_id", source: "request_id", details: { id: "t-existing" } } }
        : { status: 200, json: { items: [transfer({ request_id: "req-replacement-0001" })], page_after: null } },
    );
    const res = await f.client.createTransfer(createInput());
    expect(res.reconciled).toBe(true);
    expect(f.nonLogin()[1]!.path).toBe("/api/v1/transfers?request_id=req-replacement-0001&page=0");
  });

  it("also understands the legacy request_id_duplicate spelling", async () => {
    const f = fakeAirwallex((c) =>
      c.method === "POST"
        ? { status: 400, json: { code: "request_id_duplicate" } }
        : { status: 200, json: { items: [transfer({ request_id: "req-replacement-0001" })] } },
    );
    await expect(f.client.createTransfer(createInput())).resolves.toMatchObject({ reconciled: true });
  });

  it("refuses to adopt a duplicate whose amount differs from the intent", async () => {
    const f = fakeAirwallex((c) =>
      c.method === "POST"
        ? { status: 400, json: { code: "duplicate_request_id" } }
        : { status: 200, json: { items: [transfer({ request_id: "req-replacement-0001", transfer_amount: 999 })] } },
    );
    await expect(f.client.createTransfer(createInput())).rejects.toBeInstanceOf(AirwallexContractError);
  });

  it("network failure with no transfer found is an UNCERTAIN outcome, not a failure", async () => {
    const f = fakeAirwallex((c) =>
      c.method === "POST" ? new TypeError("fetch failed") : { status: 200, json: { items: [] } },
    );
    await expect(f.client.createTransfer(createInput())).rejects.toBeInstanceOf(AirwallexUncertainOutcomeError);
    expect(f.nonLogin().filter((c) => c.method === "POST")).toHaveLength(3);
  });

  it("network failure after the provider stored it reconciles to that transfer", async () => {
    const f = fakeAirwallex((c) =>
      c.method === "POST"
        ? new TypeError("socket hang up")
        : { status: 200, json: { items: [transfer({ request_id: "req-replacement-0001" })] } },
    );
    await expect(f.client.createTransfer(createInput())).resolves.toMatchObject({ reconciled: true });
  });

  it("does not convert a known rejection into reconciliation", async () => {
    const f = fakeAirwallex(() => ({ status: 400, json: { code: "balance_insufficient" } }));
    await expect(f.client.createTransfer(createInput())).rejects.toMatchObject({ code: "balance_insufficient" });
    expect(f.nonLogin()).toHaveLength(1);
  });

  it("validates request_id length (10-50) and positive amounts locally", async () => {
    const f = fakeAirwallex(() => ({ status: 201, json: transfer() }));
    await expect(f.client.createTransfer(createInput("short"))).rejects.toThrow();
    await expect(f.client.createTransfer({ ...createInput(), amount: money(0n, "USD") })).rejects.toThrow(RangeError);
    expect(f.nonLogin()).toHaveLength(0);
  });

  it("newRequestId is unique and in range", () => {
    const ids = new Set(Array.from({ length: 1000 }, newRequestId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id.length).toBeGreaterThanOrEqual(10);
  });
});

describe("unkeyed mutations", () => {
  it("are never retried; a network error is UNCERTAIN", async () => {
    const f = fakeAirwallex(() => new TypeError("fetch failed"));
    await expect(f.client.createBeneficiary({ nickname: "x" })).rejects.toBeInstanceOf(AirwallexUncertainOutcomeError);
    expect(f.nonLogin()).toHaveLength(1);
  });

  it("a 500 on an unkeyed mutation is UNCERTAIN and not retried", async () => {
    const f = fakeAirwallex(() => ({ status: 500 }));
    const sim = new AirwallexSimulation(f.client);
    await expect(sim.transitionTransfer("t1", "SENT")).rejects.toBeInstanceOf(AirwallexUncertainOutcomeError);
    expect(f.nonLogin()).toHaveLength(1);
  });
});

describe("simulation", () => {
  it("transition sends next_status and failure_type", async () => {
    const f = fakeAirwallex(() => ({ status: 200, json: {} }));
    await new AirwallexSimulation(f.client).transitionTransfer("t1", "FAILED", "BENEFICIARY_BANK_RETURNED");
    const c = f.nonLogin()[0]!;
    expect(c.path).toBe("/api/v1/simulation/transfers/t1/transition");
    expect(JSON.parse(c.body!)).toEqual({ next_status: "FAILED", failure_type: "BENEFICIARY_BANK_RETURNED" });
  });

  it("rejects undocumented statuses and failure types before calling the API", async () => {
    const f = fakeAirwallex(() => ({ status: 200, json: {} }));
    const sim = new AirwallexSimulation(f.client);
    // @ts-expect-error not a documented status
    await expect(sim.transitionTransfer("t1", "RETURNED")).rejects.toThrow();
    // @ts-expect-error not a documented failure type
    await expect(sim.transitionTransfer("t1", "FAILED", "BANK_RETURN")).rejects.toThrow();
    expect(f.nonLogin()).toHaveLength(0);
  });

  it("deposit amount is an exact JSON number", async () => {
    const f = fakeAirwallex(() => ({ status: 201, json: {} }));
    await new AirwallexSimulation(f.client).createDeposit({
      globalAccountId: "ga-1",
      amount: money(5_002_570n, "USD"),
      payerName: "Sandbox Funding",
    });
    expect(f.nonLogin()[0]!.body).toBe('{"amount":50025.70,"global_account_id":"ga-1","payer_name":"Sandbox Funding"}');
  });
});

describe("normalizeTransfer", () => {
  const parse = (o: Record<string, unknown>) => normalizeTransfer(TransferSchema.parse(transfer(o)));

  it("reads the current failure object", () => {
    const t = parse({
      status: "FAILED",
      failure: { code: "F01", message: "Returned by bank", details: { type: "BENEFICIARY_BANK_RETURNED", reason_codes: ["R01"] } },
    });
    expect(t.failure).toEqual({
      shape: "failure_object",
      code: "F01",
      message: "Returned by bank",
      type: "BENEFICIARY_BANK_RETURNED",
      reasonCodes: ["R01"],
    });
  });

  it("reads legacy failure_type / failure_reason", () => {
    expect(parse({ status: "CANCELLED", failure_type: "RECALL_REQUESTED", failure_reason: "recall" }).failure).toMatchObject({
      shape: "legacy_fields",
      type: "RECALL_REQUESTED",
    });
  });

  it("a bare CANCELLED has no failure facts", () => {
    expect(parse({ status: "CANCELLED", failure: {} }).failure).toBeNull();
  });

  it("maps unknown statuses to UNKNOWN but keeps the raw string", () => {
    expect(parse({ status: "RETURNED_TO_SENDER" })).toMatchObject({ status: "UNKNOWN", rawStatus: "RETURNED_TO_SENDER" });
  });

  it("converts amounts to minor units", () => {
    expect(parse({ transfer_amount: 1234.56 })).toMatchObject({
      amount: { amountMinor: 123_456n, currency: "USD" },
      feeAmountMinor: 150n,
    });
  });

  it("rejects currencies outside the allowlist", () => {
    expect(() => parse({ transfer_currency: "XAU" })).toThrow(AirwallexContractError);
  });
});
