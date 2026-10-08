import { staffPaymentLabel, type StaffPaymentAllocation } from "@/lib/staffPaymentLabel";
import { buildResidentFinancialSummary } from "@/lib/residentFinancialSummary";
import { rentPeriodLabel } from "@/lib/paymentReceiptPurpose";
import PaymentAuditDetails from "@/components/payments/PaymentAuditDetails";

export type RentCorrection = {
  id: string; resident_id: string; admission_id: string;
  original_payment_id: string; replacement_payment_id: string; wrong_rent_bill_id?: string;
  original_bill_ids?: string[]; reason?: string; actor?: string; created_at?: string;
  fee_exception_reason?: string | null;
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
  const originalBills = bills.filter(b => b.bill_type === "Rent" && (b.id === correction.wrong_rent_bill_id || correction.original_bill_ids?.includes(String(b.id))));
  const outstanding = (bill: Record<string, unknown>) => buildResidentFinancialSummary({
    admission: { id: correction.admission_id, status: "Pending" }, room: null, bed: null, bills: [bill],
    payments: payments.map(p => ({ ...p, allocations: allocations.filter(a => a.payment_id === p.id) })),
  }).monthlyRentDue;
  return <details className="mt-2 space-y-1 text-xs text-slate-700">
    <summary className="cursor-pointer font-semibold">{original ? "Correction history" : "Replacement audit history"}</summary>
    <p>Original payment allocation reversed and corrected to {purpose}.</p>
    <p>Original payment: {correction.original_payment_id} / Cancelled (historical reversal; no credit).</p>
    <p>Replacement payment: {correction.replacement_payment_id} / {String(replacement?.payment_status ?? "Status unavailable")}.</p>
    {correction.reason && <p>Reason: {correction.reason} / Actor: {correction.actor} / {correction.created_at}</p>}
    {correction.fee_exception_reason && <p>Explicit historical fee authorization: {correction.fee_exception_reason}. Future rent policy remains unchanged.</p>}
    <PaymentAuditDetails paymentIds={[correction.original_payment_id, correction.replacement_payment_id]} />
    {originalBills.map(b => <p key={String(b.id)}>Current {rentPeriodLabel(b.billing_month)} obligation: {outstanding(b) > 0 ? "Outstanding" : "Paid"} Rs{outstanding(b).toLocaleString("en-PK")} / Due {String(b.due_date ?? "unavailable")}. The payment reversal did not cancel this bill.</p>)}
  </details>;
}
