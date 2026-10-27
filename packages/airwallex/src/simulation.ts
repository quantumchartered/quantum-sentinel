import { type Money, minorToMajor } from "@sentinel/contracts";
import type { AirwallexClient } from "./client.js";
import {
  type SimulationFailureType,
  SimulationFailureTypeSchema,
  type SimulationNextStatus,
  SimulationNextStatusSchema,
} from "./schemas.js";

/**
 * SANDBOX-ONLY simulation calls, kept behind one interface (builder guide).
 * Used by operator scripts and the Scenario Lab. Never exposed to the LLM.
 * Neither endpoint documents a dedup key, so neither is retried automatically.
 */
export class AirwallexSimulation {
  private readonly client: AirwallexClient;
  constructor(client: AirwallexClient) {
    this.client = client;
  }

  /**
   * Move a sandbox transfer to `nextStatus`. Per the builder guide, a
   * failure_type only applies once the transfer has reached SENT.
   */
  async transitionTransfer(
    transferId: string,
    nextStatus: SimulationNextStatus,
    failureType?: SimulationFailureType,
  ): Promise<unknown> {
    SimulationNextStatusSchema.parse(nextStatus);
    if (failureType !== undefined) SimulationFailureTypeSchema.parse(failureType);
    const { json } = await this.client.http.requestRaw({
      method: "POST",
      path: `/api/v1/simulation/transfers/${encodeURIComponent(transferId)}/transition`,
      retry: "unkeyed",
      body: JSON.stringify({ next_status: nextStatus, ...(failureType ? { failure_type: failureType } : {}) }),
    });
    return json;
  }

  /** Simulated deposit into a global account. `amount` is a JSON number in the reference. */
  async createDeposit(input: {
    globalAccountId: string;
    amount: Money;
    payerName?: string;
    reference?: string;
  }): Promise<unknown> {
    if (input.amount.amountMinor <= 0n) throw new RangeError("deposit amount must be positive");
    // JSON.rawJSON emits the exact decimal as a number token, never via a float.
    const body = JSON.stringify({
      amount: JSON.rawJSON(minorToMajor(input.amount.amountMinor, input.amount.currency)),
      global_account_id: input.globalAccountId,
      ...(input.payerName ? { payer_name: input.payerName } : {}),
      ...(input.reference ? { reference: input.reference } : {}),
    });
    const { json } = await this.client.http.requestRaw({
      method: "POST",
      path: "/api/v1/simulation/deposit/create",
      retry: "unkeyed",
      body,
    });
    return json;
  }
}
