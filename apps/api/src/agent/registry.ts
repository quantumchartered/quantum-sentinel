import type { EVIDENCE_LABELS } from "./report.js";

export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

/** Typed facts the verifier can check claims against. */
export interface EvidenceFacts {
  providerTransferId?: string;
  transferStatus?: string;
  failureType?: string | null;
  amountMinor?: string;
  currency?: string;
  /** Monotonic order of observations for the same transfer (higher = learned later). */
  sequence?: number;
}

export interface EvidenceItem {
  id: string;
  label: EvidenceLabel;
  /** Untrusted = external text (supplier email). It can never be the sole support for a fact. */
  trusted: boolean;
  summary: string;
  facts: EvidenceFacts;
}

/**
 * Everything the model was shown during ONE run, keyed by evidence ID. The
 * verifier only accepts citations to IDs in here: the model cannot cite
 * something it never saw, nor invent an ID.
 */
export class EvidenceRegistry {
  private readonly items = new Map<string, EvidenceItem>();

  add(item: EvidenceItem): EvidenceItem {
    this.items.set(item.id, item);
    return item;
  }

  get(id: string): EvidenceItem | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  all(): EvidenceItem[] {
    return [...this.items.values()];
  }

  /** Latest known status per provider transfer (by observation sequence). */
  latestStatus(providerTransferId: string): string | undefined {
    let best: EvidenceItem | undefined;
    for (const it of this.items.values()) {
      if (it.facts.providerTransferId !== providerTransferId || it.facts.transferStatus === undefined) continue;
      if (!best || (it.facts.sequence ?? -1) > (best.facts.sequence ?? -1)) best = it;
    }
    return best?.facts.transferStatus;
  }
}
