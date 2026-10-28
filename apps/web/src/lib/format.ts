/** Display helpers. Money arrives as integer minor-unit strings and is never parsed into floats. */

const EXPONENT: Record<string, number> = { JPY: 0 };

export function formatMoney(amountMinor: string, currency: string): string {
  const exp = EXPONENT[currency] ?? 2;
  const negative = amountMinor.startsWith("-");
  const digits = (negative ? amountMinor.slice(1) : amountMinor).padStart(exp + 1, "0");
  const whole = digits.slice(0, digits.length - exp).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = exp > 0 ? `.${digits.slice(digits.length - exp)}` : "";
  return `${negative ? "−" : ""}${currency} ${whole}${frac}`;
}

export function formatMicroUsd(micro: string): string {
  const n = BigInt(micro);
  const cents = (n + 5_000n) / 10_000n; // round to the cent
  const s = cents.toString().padStart(3, "0");
  return `$${s.slice(0, -2)}.${s.slice(-2)}`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

export const shortId = (id: string, n = 8) => (id.includes(":") ? `${id.split(":")[0]}:${id.split(":")[1]!.slice(0, n)}` : id.slice(0, n));

export function actorLabel(actor: string): string {
  if (actor.startsWith("agent:")) return "AI investigator";
  if (actor.startsWith("user:")) return "Operator";
  if (actor.startsWith("lab-racer")) return "Lab racer";
  return actor.replace(/-/g, " ");
}
