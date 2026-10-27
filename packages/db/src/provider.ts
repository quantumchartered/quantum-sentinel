import type { AirwallexClient } from "@sentinel/airwallex";
import type { ExecutionProvider } from "./execution.js";
import { beneficiaryDetailsHash } from "./incidents.js";

/** The real (SANDBOX) Airwallex client as an ExecutionProvider. */
export function airwallexExecutionProvider(client: AirwallexClient): ExecutionProvider {
  return {
    getTransfer: (id) => client.getTransfer(id),
    findTransferByRequestId: (requestId) => client.findTransferByRequestId(requestId),
    createTransfer: (input) => client.createTransfer(input),
    getCurrentBalances: () => client.getCurrentBalances(),
    async getBeneficiaryHash(beneficiaryId) {
      const raw = (await client.getBeneficiary(beneficiaryId)) as { beneficiary?: { bank_details?: unknown } } | null;
      // Fails closed (throws) when bank details are absent; the executor then blocks.
      return beneficiaryDetailsHash(raw?.beneficiary?.bank_details);
    },
  };
}
