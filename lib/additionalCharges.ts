export const ADDITIONAL_CATEGORIES = [
  "Electricity / Utilities", "AC / Appliance Charges", "Maintenance / Repair",
  "Damage / Fine", "Mess / Food", "Other",
] as const;

export type AdditionalCharge = {
  amount: number; category: string; description: string; billId: string;
  rentBillId: string | null; rentAmount: number;
  depositBillId: string | null; depositAmount: number;
  confirmed?: { amount: number; category: string; description: string; by: string; at: string };
};

/** Reject precision errors rather than silently rounding a resident declaration. */
export function additionalChargeError(amount: unknown, category: unknown, description: unknown) {
  const raw = String(amount ?? "");
  if (!/^\d+(\.\d{1,2})?$/.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) <= 0 || Number(raw) > 9999999999.99) return "Additional charges must be a positive PKR amount with at most two decimals.";
  if (!ADDITIONAL_CATEGORIES.some(value => value === category)) return "Select an additional charge category.";
  if (typeof description !== "string" || description.trim().length > 500 || (category === "Other" && !description.trim())) return "Other requires a description; descriptions must be at most 500 characters.";
  return null;
}

export function additionalPaymentTotal(canonical: number, additional: number) {
  return (Math.round(canonical * 100) + Math.round(additional * 100)) / 100;
}
