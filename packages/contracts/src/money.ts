import { z } from "zod";

/**
 * Money is always an integer number of minor units (bigint) plus a currency.
 * Airwallex speaks major units ("100.50"); conversion happens only at the
 * Airwallex adapter boundary via `majorToMinor` / `minorToMajor`.
 */

// Explicit allowlist. An unknown currency is rejected rather than guessed (fail closed).
export const CURRENCY_EXPONENTS = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  SGD: 2,
  HKD: 2,
  CAD: 2,
  JPY: 0,
} as const;

export type Currency = keyof typeof CURRENCY_EXPONENTS;

export const CurrencySchema = z.enum(
  Object.keys(CURRENCY_EXPONENTS) as [Currency, ...Currency[]],
);

export function currencyExponent(currency: Currency): number {
  return CURRENCY_EXPONENTS[currency];
}

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

export const MoneySchema = z.object({
  amountMinor: z.bigint(),
  currency: CurrencySchema,
});

/** JSON-safe form: bigint travels as an integer string. */
export const MoneyJsonSchema = z.object({
  amountMinor: z.string().regex(/^-?\d+$/, "integer minor units"),
  currency: CurrencySchema,
});
export type MoneyJson = z.infer<typeof MoneyJsonSchema>;

export class MoneyError extends Error {
  override name = "MoneyError";
}

export function money(amountMinor: bigint, currency: Currency): Money {
  return { amountMinor, currency };
}

export function toMoneyJson(m: Money): MoneyJson {
  return { amountMinor: m.amountMinor.toString(), currency: m.currency };
}

export function fromMoneyJson(j: unknown): Money {
  const parsed = MoneyJsonSchema.parse(j);
  return { amountMinor: BigInt(parsed.amountMinor), currency: parsed.currency };
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Largest magnitude accepted when the provider gives us a JSON *number*.
 * Below 10^15 every decimal with the currency's precision survives a
 * round-trip through an IEEE double, so String(n) is the exact decimal.
 */
const MAX_SAFE_NUMBER_MINOR = 10n ** 15n;

/**
 * Convert a major-unit amount from Airwallex into minor units.
 * Accepts a decimal string ("100.5") or a JSON number (100.5).
 * Rejects exponent notation, excess precision, and unsafe magnitudes.
 */
export function majorToMinor(major: string | number, currency: Currency): bigint {
  const exp = currencyExponent(currency);
  let text: string;
  if (typeof major === "number") {
    if (!Number.isFinite(major)) throw new MoneyError(`non-finite amount ${major}`);
    text = String(major);
  } else {
    text = major.trim();
  }
  const m = DECIMAL.exec(text);
  if (!m) throw new MoneyError(`not a plain decimal amount: ${JSON.stringify(text)}`);
  const [, sign, whole, rawFrac = ""] = m;
  const frac = rawFrac.replace(/0+$/, "");
  if (frac.length > exp) {
    throw new MoneyError(`${text} has more than ${exp} decimal places for ${currency}`);
  }
  const minor = BigInt(whole! + frac.padEnd(exp, "0"));
  const signed = sign === "-" ? -minor : minor;
  if (typeof major === "number" && (signed < 0n ? -signed : signed) >= MAX_SAFE_NUMBER_MINOR) {
    throw new MoneyError(`numeric amount ${text} too large to trust; provider must send a string`);
  }
  return signed;
}

/** Minor units to an exact major-unit decimal string for Airwallex requests. */
export function minorToMajor(amountMinor: bigint, currency: Currency): string {
  const exp = currencyExponent(currency);
  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(exp + 1, "0");
  const whole = digits.slice(0, digits.length - exp);
  const frac = digits.slice(digits.length - exp);
  return `${negative ? "-" : ""}${whole}${exp > 0 ? `.${frac}` : ""}`;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

export function format(m: Money): string {
  return `${minorToMajor(m.amountMinor, m.currency)} ${m.currency}`;
}
