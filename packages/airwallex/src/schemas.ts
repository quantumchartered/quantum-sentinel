import { z } from "zod";

/**
 * Zod decoders for the Airwallex responses we rely on. Field names come from the
 * official API reference via the Airwallex Docs MCP (checked 2026-10-27); see
 * docs/hackathon/OFFICIAL_REQUIREMENTS.md. Objects are loose: unknown fields are
 * kept (raw payloads are stored as evidence), only the fields we read are typed.
 */

const amount = z.union([z.number(), z.string()]);

export const LoginResponseSchema = z.looseObject({
  token: z.string().min(1),
  expires_at: z.string().min(1),
});

/** Transfer statuses documented for API versions 2025-06-30 onward. */
export const KNOWN_TRANSFER_STATUSES = [
  "IN_APPROVAL",
  "APPROVAL_RECALLED",
  "APPROVAL_REJECTED",
  "APPROVAL_BLOCKED",
  "SCHEDULED",
  "OVERDUE",
  "PROCESSING",
  "SENT",
  "PAID",
  "FAILED",
  "CANCELLED",
] as const;
export type KnownTransferStatus = (typeof KNOWN_TRANSFER_STATUSES)[number];

export const TransferFailureSchema = z.looseObject({
  code: z.string().optional(),
  message: z.string().optional(),
  details: z
    .looseObject({
      type: z.string().optional(),
      reason_codes: z.array(z.string()).optional(),
    })
    .optional(),
});

export const TransferSchema = z.looseObject({
  id: z.string().min(1),
  request_id: z.string().min(1),
  status: z.string().min(1),
  transfer_amount: amount,
  transfer_currency: z.string().length(3),
  transfer_method: z.string().optional(),
  source_currency: z.string().optional(),
  fee_amount: amount.optional(),
  fee_currency: z.string().optional(),
  beneficiary_id: z.string().optional(),
  reference: z.string().optional(),
  short_reference_id: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  // Current shape (API >= 2026-06-30).
  failure: TransferFailureSchema.nullish(),
  // Legacy shape (guide, older API versions). Only read if present.
  failure_reason: z.string().nullish(),
  failure_type: z.string().nullish(),
});
export type RawTransfer = z.infer<typeof TransferSchema>;

export const TransferListSchema = z.looseObject({
  items: z.array(TransferSchema),
  page_after: z.string().nullish(),
  page_before: z.string().nullish(),
});

export const BalanceSchema = z.looseObject({
  account_type: z.string().optional(),
  currency: z.string().length(3),
  available_amount: amount.optional(),
  pending_amount: amount.optional(),
  reserved_amount: amount.optional(),
  total_amount: amount.optional(),
});
export const BalancesSchema = z.array(BalanceSchema);

export const GlobalAccountSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().optional(),
  country_code: z.string().optional(),
  request_id: z.string().optional(),
});
export const GlobalAccountListSchema = z.looseObject({
  items: z.array(GlobalAccountSchema),
});

export const ErrorBodySchema = z.looseObject({
  code: z.string().optional(),
  message: z.string().optional(),
  source: z.string().optional(),
  trace_id: z.string().optional(),
  details: z.unknown().optional(),
});

/** Documented `failure_type` values for the sandbox transition endpoint. */
export const SIMULATION_FAILURE_TYPES = [
  "ACCOUNT_CLOSED",
  "ACCOUNT_CURRENCY_MISMATCH",
  "ACCOUNT_INACTIVE_OR_DORMANT",
  "ACCOUNT_UNDER_RESTRICTION",
  "BENEFICIARY_BANK_RETURNED",
  "BENEFICIARY_NAME_MISMATCH",
  "BENEFICIARY_REQUESTED",
  "CARD_ISSUER_ERROR",
  "CHANNEL_POLICY",
  "CHANNEL_TIMEOUT",
  "CLIENT_REQUESTED",
  "DUPLICATION_RETURN",
  "EXCEEDED_TRANSACTION_AMOUNT_OR_LIMIT",
  "INBOUND_2B_CARD_NOT_SUPPORTED",
  "INBOUND_BENFICIARY_VALIDATION_ERROR",
  "INBOUND_COMPANY_REGISTRATION_NUMBER_ERROR",
  "INBOUND_ORDER_ERROR",
  "INSUFFICIENT_FUNDS",
  "INVALID_ACCOUNT_NAME_OR_NUMBER",
  "INVALID_BANK_INFORMATION",
  "INVALID_BANK_OR_BRANCH_CODE",
  "INVALID_BENEFICIARY_DETAILS",
  "INVALID_CORRESPONDENT_BANK_INFORMATION",
  "INVALID_PAYMENT_PURPOSE",
  "INVALID_SPECIAL_CHARACTER",
  "INVALID_SWIFT_BIC_CODE",
  "OTHER",
  "RECALL_REQUESTED",
  "SYSTEM_ERROR",
  "TM_SUSPENDED",
  "TRANSACTION_AMOUNT_NOT_COVERING_FEE",
  "UNABLE_TO_APPLY",
] as const;
export const SimulationFailureTypeSchema = z.enum(SIMULATION_FAILURE_TYPES);
export type SimulationFailureType = z.infer<typeof SimulationFailureTypeSchema>;

export const SIMULATION_NEXT_STATUSES = [
  "OVERDUE",
  "PROCESSING",
  "SENT",
  "PAID",
  "FAILED",
  "CANCELLED",
] as const;
export const SimulationNextStatusSchema = z.enum(SIMULATION_NEXT_STATUSES);
export type SimulationNextStatus = z.infer<typeof SimulationNextStatusSchema>;

/** Builder guide: request_id must be 10-50 characters (error code 018 otherwise). */
export const RequestIdSchema = z.string().min(10).max(50);
