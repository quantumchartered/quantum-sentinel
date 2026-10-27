import type { AirwallexClient } from "@sentinel/airwallex";
import { type Db, loadTransferHistory, recordTransferSnapshot, schema } from "@sentinel/db";
import { eq } from "drizzle-orm";

/**
 * Backup poller. Webhooks are the primary signal; polling catches missed
 * deliveries. It only ever APPENDS observations, so a poll that sees a bare
 * CANCELLED can never erase a FAILED + failure reason captured earlier.
 */

/** Transfers we know about that have not reached CANCELLED, or whose history conflicts. */
export async function listOpenTransferIds(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: schema.transferObservations.providerTransferId })
    .from(schema.transferObservations)
    .where(eq(schema.transferObservations.organizationId, organizationId));
  const open: string[] = [];
  for (const { id } of rows) {
    const h = await loadTransferHistory(db, organizationId, id);
    if (h.status !== "CANCELLED" || h.conflicts.length > 0) open.push(id);
  }
  return open;
}

export interface PollResult {
  polled: number;
  newObservations: number;
  errors: { providerTransferId: string; error: string }[];
}

export async function pollOnce(
  db: Db,
  client: AirwallexClient,
  organizationId: string,
  transferIds?: string[],
): Promise<PollResult> {
  const ids = transferIds ?? (await listOpenTransferIds(db, organizationId));
  const result: PollResult = { polled: 0, newObservations: 0, errors: [] };
  for (const id of ids) {
    try {
      const snap = await client.getTransfer(id);
      result.polled++;
      if (await recordTransferSnapshot(db, organizationId, snap, "poll")) result.newObservations++;
    } catch (err) {
      // One bad transfer must not stop the others; the error stays visible.
      result.errors.push({ providerTransferId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
