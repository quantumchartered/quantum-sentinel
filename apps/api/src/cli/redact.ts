/**
 * Redaction for fixtures and console output. Bank identifiers, tokens and
 * contact details never leave the process unmasked.
 */
const SENSITIVE_KEY =
  /^(token|api_key|x-api-key|authorization|account_number|iban|account_routing_value\d?|routing_value|swift_code|personal_email|email|phone|business_phone_number|legal_rep_.*|date_of_birth|value)$/i;

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && (typeof v === "string" || typeof v === "number") ? "[REDACTED]" : redact(v);
    }
    return out as T;
  }
  return value;
}
