import { staffPaymentLabel, type StaffPaymentAllocation } from "@/lib/staffPaymentLabel";
import { buildResidentFinancialSummary } from "@/lib/residentFinancialSummary";
import { rentPeriodLabel } from "@/lib/paymentReceiptPurpose";

export type RentCorrection = {
  id: string; resident_id: string; admission_id: string;
  original_payment_id: string; replacement_payment_id: string; wrong_rent_bill_id: string;
};

/** Read-only context. Historical receipt and payment statuses remain unchanged. */
export default function RentCorrectionContext({ paymentId, corrections, payments, allocations, bills }: {
  paymentId: string | null | undefined; corrections: RentCorrection[];
  payments: Record<string, unknown>[]; allocations: StaffPaymentAllocation[]; bills: Record<string, unknown>[];
}) {
  const correction = corrections.find(c => c.original_payment_id === paymentId || c.replacement_payment_id === paymentId);
  if (!correction) return null;
  const original = correction.original_payment_id === paymentId;
  const replacement = payments.find(p => p.id === correction.replacement_payment_id);
  const purpose = staffPaymentLabel({ id: correction.replacement_payment_id, resident_id: correction.resident_id, bill_id: replacement?.bill_id ? String(replacement.bill_id) : null }, allocations, bills);
  const wrongBill = bills.find(b => b.id === correction.wrong_rent_bill_id);
  const outstanding = wrongBill ? buildResidentFinancialSummary({
    admission: { id: correction.admission_id, status: "Pending" }, room: null, bed: null, bills: [wrongBill],
    payments: payments.map(p => ({ ...p, allocations: allocations.filter(a => a.payment_id === p.id) })),
  }).monthlyRentDue : null;
  return <div className="mt-2 space-y-1 text-xs text-slate-700">
    <p className="font-semibold">{original ? "Corrected / Reallocated" : "Replacement payment for rent-period correction"}</p>
    <p>Original payment allocation reversed and corrected to {purpose}.</p>
    <p>Original payment: {correction.original_payment_id} / Cancelled (historical reversal; no credit).</p>
    <p>Replacement payment: {correction.replacement_payment_id} / {String(replacement?.payment_status ?? "Status unavailable")}.</p>
    {wrongBill && outstanding !== null && <p>Current {rentPeriodLabel(wrongBill.billing_month)} obligation: {outstanding > 0 ? "Outstanding" : "Paid"} Rs{outstanding.toLocaleString("en-PK")} / Due {String(wrongBill.due_date ?? "unavailable")}. The payment reversal did not cancel this bill.</p>}
  </div>;
}
