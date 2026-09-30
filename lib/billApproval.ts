export const UNAPPROVED_BILL_STATUSES = ["Pending Approval", "Draft"] as const;

export type UnapprovedBillStatus = (typeof UNAPPROVED_BILL_STATUSES)[number];

const unapprovedStatusSet = new Set<string>(
  UNAPPROVED_BILL_STATUSES.map((status) => status.toLowerCase()),
);

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

/** A bill an admin has generated but not yet released to the resident. */
export function isUnapprovedBill(status: unknown) {
  return unapprovedStatusSet.has(normalized(status));
}

export function billingMonthOf(date = new Date()) {
  return date.toISOString().slice(0, 10).slice(0, 7);
}

export function isBillingMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function monthStartDate(billingMonth: string) {
  return `${billingMonth.slice(0, 7)}-01`;
}

/** Initial rent is immediate; clamp recurring anniversaries before subtracting a day. */
export function rentDueDate(admissionDate: string, billingMonth: string) {
  const admission = admissionDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(admission) ||
      !Number.isFinite(Date.parse(admission + "T00:00:00Z")) ||
      new Date(admission + "T00:00:00Z").toISOString().slice(0, 10) !== admission ||
      !isBillingMonth(billingMonth) || billingMonth < admission.slice(0, 7)) {
    throw new Error("A valid admission date and current or later billing month are required.");
  }
  if (billingMonth === admission.slice(0, 7)) return admission;
  const [year, month] = billingMonth.split("-").map(Number);
  const day = Math.min(Number(admission.slice(8, 10)), new Date(Date.UTC(year, month, 0)).getUTCDate());
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

export function billingMonthLabel(value: string) {
  const parsed = new Date(`${monthStartDate(value)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString("en-PK", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
}
