import type { RiskFlag } from "./decide.js";

/**
 * Deterministic screening of UNTRUSTED supplier text (emails, chat). Runs in
 * code before any model sees the text, so a bank-detail change request blocks
 * payment even if the model is fooled (AGENTS.md §6.13). Deliberately broad:
 * a false positive costs a human review; a false negative could cost a payment.
 */

const BANK_CHANGE: RegExp[] = [
  /\b(new|updated|changed|different|another|alternative|correct(?:ed)?)\s+(bank|banking|account|beneficiary|remittance|payment)\s*(details|info(?:rmation)?|account|number|instructions)?\b/i,
  /\b(bank|banking|account|payment|remittance)\s+(details|information|instructions)\s+(have|has)\s+(changed|been updated)\b/i,
  /\b(change|update|replace)\s+(of\s+)?(our|the|your\s+records\s+of\s+our)?\s*(bank|banking|account|payment)\s*(details|account|information|instructions)?\b/i,
  /\b(re-?send|resend|pay|send|transfer|remit)\b.{0,60}\b(new|different|another|other)\s+(bank\s+)?account\b/i,
  /\bdo not (use|pay to|send to) (the|our) (old|previous|existing) (account|bank)\b/i,
  /\b(iban|swift|bic|routing|sort code|account (number|no\.?))\b.{0,40}\b(new|changed|updated|is now)\b/i,
];

const INJECTION: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|all|any|your)\b.{0,20}\b(instructions?|rules?|prompts?|guidelines?|policy|policies)\b/i,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  /\byou are (now|no longer)\b/i,
  /\b(as an? (ai|assistant|language model))\b/i,
  /\b(approve|execute|release|send|process)\b.{0,30}\b(immediately|right now|without (approval|review|checking|verification))\b/i,
  /\b(call|use|invoke)\s+(the\s+)?(propose_action|submit_report|tool)\b/i,
  /<\/?(system|instructions?|tool|assistant)[^>]*>/i,
];

const RECEIPT: RegExp[] = [
  /\b(we|i)\s*(have|'ve|did)?\s*(now|just|already|finally)?\s*(received|got)\s+(it|the (payment|funds|money|transfer))\b/i,
  /\b(payment|funds|money|transfer|remittance)\b.{0,30}\b(has arrived|arrived|has landed|landed|came through|has been received|was received|reached us|is in our account)\b/i,
  /\bthank(s| you)? for (the |your )?(payment|transfer)\b/i,
];
const NEGATION = /\b(not|never|no|haven't|hasn't|didn't|isn't|wasn't|nothing|yet to)\b|n't\b/i;

export interface TextSignals {
  flags: RiskFlag[];
  matches: { flag: RiskFlag; excerpt: string }[];
}

export function detectSupplierTextSignals(text: string): TextSignals {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ");
  const matches: TextSignals["matches"] = [];
  const scan = (patterns: RegExp[], flag: RiskFlag) => {
    for (const p of patterns) {
      const m = p.exec(normalized);
      if (m) {
        matches.push({ flag, excerpt: m[0].slice(0, 120) });
        return;
      }
    }
  };
  scan(BANK_CHANGE, "BANK_DETAIL_CHANGE_REQUEST");
  scan(INJECTION, "PROMPT_INJECTION_SUSPECTED");
  // A supplier saying the money ARRIVED contradicts any replacement: a person must reconcile first.
  // Checked per sentence so "we have not received" never counts as a receipt claim.
  for (const sentence of normalized.split(/(?<=[.!?])\s+/)) {
    if (NEGATION.test(sentence)) continue;
    const m = RECEIPT.map((p) => p.exec(sentence)).find(Boolean);
    if (m) {
      matches.push({ flag: "EVIDENCE_CONFLICT", excerpt: m[0].slice(0, 120) });
      break;
    }
  }
  return { flags: [...new Set(matches.map((m) => m.flag))], matches };
}
