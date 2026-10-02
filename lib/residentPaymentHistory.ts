import { allocatedPaymentLabel, isSecurityDepositReceipt, receiptPaymentMethod } from "./paymentReceiptPurpose";

export type PaymentHistoryRow = Record<string, unknown>;
export type ResidentPaymentStatus = "Paid" | "Pending" | "Rejected" | "Refunded" | "Cancelled";

export type ResidentPaymentHistoryEntry = {
  key: string;
  source: "payment" | "receipt";
  sourceId: string;
  date: string;
  paymentType: string;
  billReference: string;
  amount: number;
  method: string;
  status: ResidentPaymentStatus;
  downloadable: boolean;
};

export type ResidentPaymentHistorySummary = {
  totalPaid: number;
  currentYearPaid: number;
  lastPaymentDate: string | null;
  lastPaymentAmount: number;
};

function text(value: unknown) {
  return value == null ? "" : String(value).trim();
}

function paymentStatus(value: unknown): ResidentPaymentStatus {
  const status = text(value).toLowerCase();
  if (status === "verified") return "Paid";
  if (status === "cancelled") return "Cancelled";
  if (status === "rejected") return "Rejected";
  if (status === "refunded") return "Refunded";
  return "Pending";
}

function billMonth(value: unknown) {
  const month = text(value).slice(0, 7);
  if (!month) return "";
  const parsed = new Date(`${month}-01T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? month
    : parsed.toLocaleDateString("en-PK", { month: "long", year: "numeric" });
}

export function buildResidentPaymentHistory({ bills, payments, receipts }: {
  bills: PaymentHistoryRow[];
  payments: PaymentHistoryRow[];
  receipts: PaymentHistoryRow[];
}) {
  const billMap = new Map(bills.map((bill) => [text(bill.id), bill]));
  const paymentIds = new Set(payments.map(payment => text(payment.id)));
  const entries: ResidentPaymentHistoryEntry[] = [];

  for (const payment of payments) {
    const id = text(payment.id);
    if (!id) continue;
    const allocations = Array.isArray(payment.allocations) ? payment.allocations : [];
    const bill = billMap.get(text(payment.bill_id)) || billMap.get(text(allocations[0]?.bill_id));
    const status = paymentStatus(payment.payment_status);
    const declaration = receipts.find(receipt => receipt.payment_id === id)?.additional_charge as Record<string, unknown> | undefined;
    const allocationLabel = declaration ? [declaration.rentBillId ? "Rent" : "", declaration.depositBillId ? "Security Deposit" : "", "Additional Charges"].filter(Boolean).join(" + ") : allocatedPaymentLabel(allocations, bills);
    entries.push({
      key: `payment-${id}`,
      source: "payment",
      sourceId: id,
      date: text(payment.payment_date ?? payment.verified_at ?? payment.created_at).slice(0, 10),
      paymentType: (declaration || allocations.length > 1) ? allocationLabel : bill ? `Bill payment${billMonth(bill.billing_month) ? ` · ${billMonth(bill.billing_month)}` : ""}` : "Account payment",
      billReference: (declaration || allocations.length > 1) ? allocationLabel : text(bill?.bill_number) || text(payment.reference_number) || "Historical payment",
      amount: Number(payment.amount || 0),
      method: text(payment.payment_method) || "Payment method not recorded",
      status,
      downloadable: status === "Paid",
    });
  }

  for (const receipt of receipts) {
    const id = text(receipt.id);
    if (!id || paymentIds.has(text(receipt.payment_id))) continue;
    const bill = billMap.get(text(receipt.bill_id));
    const deposit = isSecurityDepositReceipt(receipt.notes);
    // Proof approval alone is not a posted payment. Unlinked approved proof requires reconciliation.
    const status = paymentStatus(receipt.status) === "Paid" ? "Pending" : paymentStatus(receipt.status);
    entries.push({
      key: `receipt-${id}`,
      source: "receipt",
      sourceId: id,
      date: text(receipt.verified_at ?? receipt.created_at).slice(0, 10),
      paymentType: deposit ? "Security deposit" : bill ? `Bill receipt${billMonth(bill.billing_month) ? ` · ${billMonth(bill.billing_month)}` : ""}` : "Receipt submission",
      billReference: deposit ? "Security Deposit" : text(bill?.bill_number) || text(receipt.reference_number) || "Receipt submission",
      amount: Number(receipt.amount || 0),
      method: receiptPaymentMethod(receipt.notes) || "Payment method not recorded",
      status,
      downloadable: false,
    });
  }

  entries.sort((a, b) => b.date.localeCompare(a.date) || b.key.localeCompare(a.key));
  const paidEntries = entries.filter((entry) => entry.status === "Paid");
  const currentYear = String(new Date().getFullYear());
  const summary: ResidentPaymentHistorySummary = {
    totalPaid: paidEntries.reduce((sum, entry) => sum + entry.amount, 0),
    currentYearPaid: paidEntries.filter((entry) => entry.date.startsWith(currentYear)).reduce((sum, entry) => sum + entry.amount, 0),
    lastPaymentDate: paidEntries[0]?.date ?? null,
    lastPaymentAmount: paidEntries[0]?.amount ?? 0,
  };

  return { entries, summary };
}
