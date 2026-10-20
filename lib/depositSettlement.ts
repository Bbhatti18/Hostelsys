export type DepositRefundType =
  | "Fully Refunded"
  | "Partially Refunded"
  | "No Refund";

export type DepositDisplayStatus =
  | "Pending"
  | "Held"
  | "Fully Refunded"
  | "Partially Refunded"
  | "No Refund"
  | "Released"
  | "Deducted";

export type DepositSettlementRecord = {
  refundType: DepositRefundType;
  depositAmount: number;
  refundAmount: number;
  deductedAmount: number;
  deductionReason?: string;
  refundMethod?: string;
  settledAt: string;
  settledBy?: string;
  notes?: string;
};

const SETTLEMENT_TAG_PREFIX = "[DEPOSIT_SETTLEMENT:";
const SETTLEMENT_TAG_SUFFIX = "]";

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * Parses structured deposit settlement record from notes string if present.
 */
export function parseDepositSettlement(notes?: string | null): DepositSettlementRecord | null {
  const content = text(notes);
  if (!content) return null;

  const startIndex = content.indexOf(SETTLEMENT_TAG_PREFIX);
  if (startIndex === -1) return null;

  const endIndex = content.indexOf(SETTLEMENT_TAG_SUFFIX, startIndex);
  if (endIndex === -1) return null;

  const jsonStr = content.slice(
    startIndex + SETTLEMENT_TAG_PREFIX.length,
    endIndex,
  );

  try {
    const parsed = JSON.parse(jsonStr) as Partial<DepositSettlementRecord>;
    if (
      parsed &&
      (parsed.refundType === "Fully Refunded" ||
        parsed.refundType === "Partially Refunded" ||
        parsed.refundType === "No Refund")
    ) {
      return {
        refundType: parsed.refundType,
        depositAmount: Number(parsed.depositAmount || 0),
        refundAmount: Number(parsed.refundAmount || 0),
        deductedAmount: Number(parsed.deductedAmount || 0),
        deductionReason: text(parsed.deductionReason) || undefined,
        refundMethod: text(parsed.refundMethod) || undefined,
        settledAt: text(parsed.settledAt) || new Date().toISOString(),
        settledBy: text(parsed.settledBy) || undefined,
        notes: text(parsed.notes) || undefined,
      };
    }
  } catch {
    // Return null if JSON parsing fails
  }

  return null;
}

/**
 * Embeds or replaces the structured deposit settlement tag into existing notes.
 */
export function embedDepositSettlementNote(
  existingNotes: string | null | undefined,
  settlement: DepositSettlementRecord,
): string {
  const current = text(existingNotes);
  const tag = `${SETTLEMENT_TAG_PREFIX}${JSON.stringify(settlement)}${SETTLEMENT_TAG_SUFFIX}`;

  const startIndex = current.indexOf(SETTLEMENT_TAG_PREFIX);
  if (startIndex !== -1) {
    const endIndex = current.indexOf(SETTLEMENT_TAG_SUFFIX, startIndex);
    if (endIndex !== -1) {
      // Replace existing tag
      const before = current.slice(0, startIndex).trimEnd();
      const after = current.slice(endIndex + SETTLEMENT_TAG_SUFFIX.length).trimStart();
      return [before, tag, after].filter(Boolean).join("\n\n");
    }
  }

  return current ? `${current}\n\n${tag}` : tag;
}

/**
 * Returns a human-friendly display label and badge style for deposit status.
 */
export function getDepositDisplayInfo(
  rawStatus: string | null | undefined,
  notes?: string | null,
): {
  status: DepositDisplayStatus;
  label: string;
  badgeClass: string;
  settlement: DepositSettlementRecord | null;
} {
  const raw = text(rawStatus);
  const settlement = parseDepositSettlement(notes);

  if (settlement) {
    if (settlement.refundType === "Fully Refunded") {
      return {
        status: "Fully Refunded",
        label: "Fully Refunded",
        badgeClass: "bg-blue-100 text-blue-800 border-blue-200",
        settlement,
      };
    }
    if (settlement.refundType === "Partially Refunded") {
      return {
        status: "Partially Refunded",
        label: "Partially Refunded",
        badgeClass: "bg-purple-100 text-purple-800 border-purple-200",
        settlement,
      };
    }
    if (settlement.refundType === "No Refund") {
      return {
        status: "No Refund",
        label: "No Refund (Deducted)",
        badgeClass: "bg-rose-100 text-rose-800 border-rose-200",
        settlement,
      };
    }
  }

  if (raw === "Released") {
    return {
      status: "Fully Refunded",
      label: "Fully Refunded",
      badgeClass: "bg-blue-100 text-blue-800 border-blue-200",
      settlement: null,
    };
  }

  if (raw === "Deducted") {
    return {
      status: "No Refund",
      label: "No Refund (Deducted)",
      badgeClass: "bg-rose-100 text-rose-800 border-rose-200",
      settlement: null,
    };
  }

  if (raw === "Held") {
    return {
      status: "Held",
      label: "Held",
      badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-200",
      settlement: null,
    };
  }

  return {
    status: "Pending",
    label: "Pending",
    badgeClass: "bg-amber-100 text-amber-800 border-amber-200",
    settlement: null,
  };
}
