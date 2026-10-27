/**
 * MOCK provider for the Scenario Lab's MOCK mode. It never calls Airwallex.
 * Its "provider state" is Sentinel's own observation log, so it survives a
 * restart and every simulated event stays visible in Decision Replay. Every
 * incident that uses it is labelled MOCK_SCENARIO in the database and the UI.
 */
import { randomUUID } from "node:crypto";
import {
  type CreateTransferInput,
  type CreateTransferResult,
  type CurrentBalance,
  type TransferSnapshot,
  TransferSchema,
  normalizeTransfer,
} from "@sentinel/airwallex";
import { minorToMajor } from "@sentinel/contracts";
import { type Db, type ExecutionProvider, recordTransferSnapshot, schema } from "@sentinel/db";
import { and, desc, eq, sql } from "drizzle-orm";

export class MockProvider implements ExecutionProvider {
  readonly label = "MOCK";
  private readonly db: Db;
  private readonly organizationId: string;
  /** Simulated wallet balance per currency (minor units). */
  balances = new Map<string, bigint>([["USD", 6_000_000n]]);
  /** Beneficiary ids whose bank details were "changed at the provider" by a Lab event. */
  changedBeneficiaries = new Set<string>();
  createCalls = 0;

  constructor(db: Db, organizationId: string) {
    this.db = db;
    this.organizationId = organizationId;
  }

  private async latestSnapshot(where: ReturnType<typeof and>): Promise<TransferSnapshot | null> {
    const [row] = await this.db.select().from(schema.transferObservations).where(where).orderBy(desc(schema.transferObservations.id)).limit(1);
    return row ? normalizeTransfer(TransferSchema.parse(row.snapshot)) : null;
  }

  async getTransfer(id: string): Promise<TransferSnapshot> {
    const s = await this.latestSnapshot(and(eq(schema.transferObservations.organizationId, this.organizationId), eq(schema.transferObservations.providerTransferId, id)));
    if (!s) throw new Error(`MOCK provider: unknown transfer ${id}`);
    return s;
  }

  async findTransferByRequestId(requestId: string): Promise<TransferSnapshot | null> {
    return this.latestSnapshot(
      and(eq(schema.transferObservations.organizationId, this.organizationId), sql`${schema.transferObservations.snapshot}->>'request_id' = ${requestId}`),
    );
  }

  async createTransfer(input: CreateTransferInput): Promise<CreateTransferResult> {
    const existing = await this.findTransferByRequestId(input.requestId);
    if (existing) return { transfer: existing, reconciled: true };
    this.createCalls++;
    const raw = TransferSchema.parse({
      id: `mock-tr-${randomUUID()}`,
      request_id: input.requestId,
      status: "SCHEDULED",
      transfer_amount: minorToMajor(input.amount.amountMinor, input.amount.currency),
      transfer_currency: input.amount.currency,
      source_currency: input.sourceCurrency,
      transfer_method: input.transferMethod,
      beneficiary_id: input.beneficiaryId,
      reference: input.reference,
      created_at: new Date().toISOString(),
    });
    const snap = normalizeTransfer(raw);
    await recordTransferSnapshot(this.db, this.organizationId, snap, "create");
    const bal = this.balances.get(input.amount.currency) ?? 0n;
    this.balances.set(input.amount.currency, bal - input.amount.amountMinor);
    return { transfer: snap, reconciled: false };
  }

  async getCurrentBalances(): Promise<CurrentBalance[]> {
    return [...this.balances.entries()].map(([currency, availableMinor]) => ({
      currency: currency as CurrentBalance["currency"],
      availableMinor,
      pendingMinor: 0n,
      reservedMinor: 0n,
    }));
  }

  async getBeneficiaryHash(beneficiaryId: string): Promise<string> {
    const [ob] = await this.db
      .select({ hash: schema.obligations.beneficiaryHash })
      .from(schema.obligations)
      .where(and(eq(schema.obligations.organizationId, this.organizationId), eq(schema.obligations.beneficiaryId, beneficiaryId)))
      .limit(1);
    if (!ob) throw new Error(`MOCK provider: unknown beneficiary ${beneficiaryId}`);
    return this.changedBeneficiaries.has(beneficiaryId) ? "f".repeat(64) : ob.hash;
  }
}
