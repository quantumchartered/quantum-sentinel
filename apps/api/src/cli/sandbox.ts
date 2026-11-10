/**
 * SANDBOX operator CLI. Every command talks to https://api.sandbox.airwallex.com
 * only (enforced by @sentinel/airwallex). Simulated funds, synthetic supplier.
 *
 *   pnpm sandbox check                         read-only: auth, balances, global accounts
 *   pnpm sandbox seed-org                      create the tenant row for SENTINEL_ORGANIZATION_ID
 *   pnpm sandbox fund --amount 60000           ensure a USD global account, simulate a deposit
 *   pnpm sandbox beneficiary                   create the synthetic demo supplier (US / USD / ACH)
 *   pnpm sandbox transfer --beneficiary ID --amount 25000 [--reference INV-1042]
 *   pnpm sandbox transition --id ID --to SENT|PAID|FAILED [--failure-type BENEFICIARY_BANK_RETURNED]
 *   pnpm sandbox watch --id ID [--seconds 20] [--interval-ms 500]
 *   pnpm sandbox history --id ID
 *   pnpm sandbox scenario-a --beneficiary ID [--amount 25000]   Scenario A end to end on the sandbox
 *
 * Redacted responses are written to fixtures/sandbox/ as contract evidence.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  AirwallexApiError,
  AirwallexClient,
  AirwallexUncertainOutcomeError,
  SimulationFailureTypeSchema,
  SimulationNextStatusSchema,
  newRequestId,
} from "@sentinel/airwallex";
import { AirwallexSimulation } from "@sentinel/airwallex/simulation";
import { majorToMinor, money } from "@sentinel/contracts";
import { createDb, loadTransferHistory, migrate, recordTransferSnapshot, schema } from "@sentinel/db";
import { classifyFinality } from "@sentinel/policy";
import { eq } from "drizzle-orm";
import { MOCK_MODEL_ID, MockInvestigatorModel } from "../agent/mock-investigator.js";
import { DEFAULT_MODEL, anthropicModelClient } from "../agent/model.js";
import { redact } from "./redact.js";
import { runSandboxScenarioA } from "./sandbox-scenario.js";

const FIXTURES = new URL("../../../../fixtures/sandbox/", import.meta.url);
const CURRENCY = "USD" as const;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example and docs/SETUP.md)`);
  return v;
}

function airwallex() {
  return new AirwallexClient({
    clientId: env("AIRWALLEX_CLIENT_ID"),
    apiKey: env("AIRWALLEX_API_KEY"),
    apiVersion: process.env.AIRWALLEX_API_VERSION || undefined,
  });
}

async function database() {
  const db = createDb({ connectionString: env("DATABASE_URL") });
  await migrate(db);
  return db;
}

async function saveFixture(name: string, data: unknown): Promise<void> {
  await mkdir(FIXTURES, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = new URL(`${stamp}_${name}.json`, FIXTURES);
  const doc = {
    label: "SANDBOX fixture (redacted)",
    capturedAt: new Date().toISOString(),
    apiVersion: process.env.AIRWALLEX_API_VERSION || "(account default)",
    data: redact(data),
  };
  await writeFile(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`  fixture: fixtures/sandbox/${stamp}_${name}.json`);
}

const print = (label: string, data: unknown) => console.log(`${label}\n${JSON.stringify(redact(data), (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}`);

function hasCurrency(ga: Record<string, unknown>, currency: string): boolean {
  const lists = [ga.required_features, ga.supported_features].filter(Array.isArray) as Record<string, unknown>[][];
  return ga.currency === currency || lists.some((l) => l.some((f) => f.currency === currency));
}

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    amount: { type: "string" },
    beneficiary: { type: "string" },
    reference: { type: "string" },
    id: { type: "string" },
    to: { type: "string" },
    "failure-type": { type: "string" },
    seconds: { type: "string" },
    "interval-ms": { type: "string" },
  },
});

const commands: Record<string, () => Promise<void>> = {
  async check() {
    const aw = airwallex();
    console.log("SANDBOX check (read-only)");
    await aw.http.getToken();
    console.log("  login: ok (token cached in memory only)");
    const balances = await aw.http.requestRaw({ method: "GET", path: "/api/v1/balances/current", retry: "read" });
    print("  balances:", balances.json);
    await saveFixture("balances_current", balances.json);
    const gas = await aw.http.requestRaw({ method: "GET", path: "/api/v1/global_accounts", retry: "read" });
    print("  global accounts:", gas.json);
    await saveFixture("global_accounts_list", gas.json);
  },

  async "seed-org"() {
    const db = await database();
    const id = process.env.SENTINEL_ORGANIZATION_ID;
    if (!id) {
      console.log(`Add this to .env, then re-run:\nSENTINEL_ORGANIZATION_ID=${randomUUID()}`);
      return;
    }
    await db.insert(schema.organizations).values({ id, name: "Sandbox Business" }).onConflictDoNothing();
    console.log(`organization ${id} ready`);
    await db.$client.end();
  },

  async fund() {
    const amount = money(majorToMinor(args.amount ?? "60000", CURRENCY), CURRENCY);
    const aw = airwallex();
    const items = await aw.listGlobalAccounts();
    let ga = items.find((g) => hasCurrency(g, CURRENCY) && (g.status === undefined || g.status === "ACTIVE"));
    if (!ga) {
      console.log("No active USD global account; creating one (country US, LOCAL)...");
      ga = await aw.createGlobalAccount({ requestId: newRequestId(), countryCode: "US", currency: CURRENCY, transferMethod: "LOCAL" });
      await saveFixture("global_account_create", ga);
    }
    console.log(`  global account ${ga.id} (${ga.status ?? "status n/a"})`);
    const deposit = await new AirwallexSimulation(aw).createDeposit({
      globalAccountId: ga.id,
      amount,
      payerName: "Sentinel Sandbox Funding",
      reference: "SIMULATED DEPOSIT",
    });
    print("  SIMULATED deposit:", deposit);
    await saveFixture("simulation_deposit_create", deposit);
    print("  balances after deposit:", await aw.getCurrentBalances());
  },

  async beneficiary() {
    const aw = airwallex();
    const generated = await aw.generateBeneficiarySchema({
      bank_country_code: "US",
      account_currency: CURRENCY,
      transfer_method: "LOCAL",
      entity_type: "COMPANY",
      local_clearing_system: "ACH",
    });
    await saveFixture("beneficiary_api_schema_us_usd_ach_company", generated);
    // Synthetic supplier. Bank numbers are the public examples from the Airwallex docs.
    const body: Record<string, unknown> = {
      nickname: "Northwind Components (SANDBOX)",
      // Create takes an array (verified in the sandbox: a bare transfer_method is rejected);
      // the generated form schema names the same field transfer_method.
      transfer_methods: ["LOCAL"],
      beneficiary: {
        entity_type: "COMPANY",
        type: "BANK_ACCOUNT",
        company_name: "Northwind Components Ltd (SANDBOX)",
        address: { country_code: "US", street_address: "412 5th Avenue", city: "Seattle", state: "US-WA", postcode: "98104" },
        bank_details: {
          bank_country_code: "US",
          account_currency: CURRENCY,
          local_clearing_system: "ACH",
          account_name: "Northwind Components Ltd",
          bank_account_category: "Checking",
          account_number: "50001121",
          account_routing_type1: "aba",
          account_routing_value1: "021000021",
          bank_name: "JPMorgan Chase Bank",
        },
      },
    };
    // Do not guess: every required path in the generated schema must be present and match its pattern.
    const fields = ((generated as { fields?: { path?: string; required?: boolean; rule?: { pattern?: string } }[] }).fields ?? []).filter((f) => f.required && f.path);
    const at = (p: string) =>
      p === "transfer_method"
        ? (body.transfer_methods as string[])[0]
        : p.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], body);
    const missing = fields.filter((f) => at(f.path!) === undefined).map((f) => f.path!);
    const invalid = fields
      .filter((f) => f.rule?.pattern && at(f.path!) !== undefined && !new RegExp(`^(?:${f.rule.pattern})$`).test(String(at(f.path!))))
      .map((f) => f.path!);
    if (missing.length || invalid.length) {
      console.error(`Payload does not match the generated schema. Missing: ${missing.join(", ") || "none"}. Invalid: ${invalid.join(", ") || "none"}. Not creating.`);
      process.exitCode = 1;
      return;
    }
    const created = await aw.createBeneficiary(body);
    await saveFixture("beneficiary_create", created);
    print("  beneficiary created:", created);
  },

  async transfer() {
    const beneficiaryId = args.beneficiary ?? env("SENTINEL_BENEFICIARY_ID");
    const amount = money(majorToMinor(args.amount ?? "25000", CURRENCY), CURRENCY);
    const orgId = env("SENTINEL_ORGANIZATION_ID");
    const db = await database();
    const aw = airwallex();
    const requestId = newRequestId();
    const input = {
      requestId,
      beneficiaryId,
      amount,
      sourceCurrency: CURRENCY,
      transferMethod: "LOCAL" as const,
      reason: "goods_purchased",
      reference: args.reference ?? "INV-1042",
    };
    const opId = randomUUID();
    const requestBody = { ...input, amount: { amountMinor: amount.amountMinor.toString(), currency: amount.currency } };
    // Persist the intent BEFORE calling the provider, so a crash leaves a record to reconcile.
    await db.insert(schema.providerOperations).values({
      id: opId,
      organizationId: orgId,
      kind: "transfer.create",
      requestId,
      requestBody,
      bodySha256: createHash("sha256").update(JSON.stringify(requestBody)).digest("hex"),
      outcome: "PENDING",
    });
    try {
      const { transfer, reconciled } = await aw.createTransfer(input);
      await recordTransferSnapshot(db, orgId, transfer, reconciled ? "reconcile" : "create");
      await db
        .update(schema.providerOperations)
        .set({ outcome: "SUCCEEDED", response: transfer.raw, updatedAt: new Date() })
        .where(eq(schema.providerOperations.id, opId));
      await saveFixture("transfer_create", transfer.raw);
      console.log(`transfer ${transfer.providerTransferId} ${transfer.rawStatus} request_id=${requestId}${reconciled ? " (reconciled)" : ""}`);
    } catch (err) {
      const outcome = err instanceof AirwallexUncertainOutcomeError ? "UNCERTAIN" : "REJECTED";
      await db
        .update(schema.providerOperations)
        .set({ outcome, error: err instanceof Error ? err.message : String(err), updatedAt: new Date() })
        .where(eq(schema.providerOperations.id, opId));
      throw err;
    } finally {
      await db.$client.end();
    }
  },

  async transition() {
    const id = args.id ?? env("SENTINEL_TRANSFER_ID");
    const to = SimulationNextStatusSchema.parse(args.to);
    const failureType = args["failure-type"] ? SimulationFailureTypeSchema.parse(args["failure-type"]) : undefined;
    const res = await new AirwallexSimulation(airwallex()).transitionTransfer(id, to, failureType);
    await saveFixture(`simulation_transition_${to}${failureType ? `_${failureType}` : ""}`, res);
    print(`SIMULATED transition -> ${to}${failureType ? ` (${failureType})` : ""}:`, res);
  },

  async watch() {
    const id = args.id ?? env("SENTINEL_TRANSFER_ID");
    const orgId = env("SENTINEL_ORGANIZATION_ID");
    const seconds = Number(args.seconds ?? "20");
    const interval = Number(args["interval-ms"] ?? "500");
    const db = await database();
    const aw = airwallex();
    const start = Date.now();
    let last = "";
    while (Date.now() - start < seconds * 1000) {
      const snap = await aw.getTransfer(id);
      const sig = `${snap.rawStatus}|${JSON.stringify(snap.failure)}`;
      if (sig !== last) {
        last = sig;
        await recordTransferSnapshot(db, orgId, snap, "poll");
        await saveFixture(`transfer_get_${snap.rawStatus}`, snap.raw);
        console.log(`+${String(Date.now() - start).padStart(6)} ms  ${snap.rawStatus}  failure=${JSON.stringify(snap.failure)}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    await db.$client.end();
  },

  async "scenario-a"() {
    const db = await database();
    const useClaude = !!process.env.ANTHROPIC_API_KEY && process.env.SENTINEL_INVESTIGATOR !== "mock";
    const secret = env("APPROVAL_HMAC_SECRET"); // same key version as the API ("env-1"), so the console can verify these approvals
    console.log("SANDBOX Scenario A (simulated funds, synthetic supplier)");
    try {
      const r = await runSandboxScenarioA({
        db,
        client: airwallex(),
        organizationId: env("SENTINEL_ORGANIZATION_ID"),
        beneficiaryId: args.beneficiary ?? env("SENTINEL_BENEFICIARY_ID"),
        amount: money(majorToMinor(args.amount ?? "25000", CURRENCY), CURRENCY),
        keys: { current: { version: "env-1", secret }, all: { "env-1": secret } },
        investigator: useClaude
          ? { model: anthropicModelClient(), modelId: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL }
          : { model: new MockInvestigatorModel(), modelId: MOCK_MODEL_ID },
        log: (line) => console.log(line),
      });
      console.log(`\nincident ${r.incidentId}: ${r.ok ? "completed" : "completed with findings"}`);
      if (!r.ok) process.exitCode = 1;
    } finally {
      await db.$client.end();
    }
  },

  async history() {
    const id = args.id ?? env("SENTINEL_TRANSFER_ID");
    const db = await database();
    const h = await loadTransferHistory(db, env("SENTINEL_ORGANIZATION_ID"), id);
    print(`history for ${id}:`, { status: h.status, statusesSeen: h.statusesSeen, failures: h.failures, conflicts: h.conflicts });
    print("finality:", classifyFinality(h));
    await db.$client.end();
  },
};

const cmd = positionals[0] ?? "";
const run = commands[cmd];
if (!run) {
  console.error(`Unknown command "${cmd}". Commands: ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}
run().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  if (err instanceof AirwallexApiError && err.details) print("  details:", err.details);
  const cause = err instanceof AirwallexUncertainOutcomeError ? err.cause : undefined;
  if (cause instanceof Error) console.error(`  cause: ${cause.name}: ${cause.message}`);
  if (cause instanceof AirwallexApiError && cause.details) print("  cause details:", cause.details);
  process.exit(1);
});
