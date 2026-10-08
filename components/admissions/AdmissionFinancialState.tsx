import { buildResidentFinancialSummary } from "@/lib/residentFinancialSummary";
import { rentPeriodLabel } from "@/lib/paymentReceiptPurpose";
import BillPaymentActions from "@/components/payments/BillPaymentActions";

/** Per-period display only; activation still uses the initial admission-month rent. */
export default function AdmissionFinancialState({ admission, bills, payments }: {
  admission: Record<string, unknown>; bills: Record<string, unknown>[] | undefined;
  payments: Record<string, unknown>[] | undefined;
}) {
  if (!bills || !payments) return <p>Financial balances unavailable</p>;
  const current = bills.filter(b => b.admission_id === admission.id && b.resident_id === admission.resident_id && b.bill_type === "Rent" && b.bill_status !== "Cancelled");
  const canonicalPayments = payments.filter(p => p.resident_id === admission.resident_id).map(p => ({ ...p,
    allocations: Array.isArray(p.payment_allocations) ? p.payment_allocations : [],
  }));
  const deposit = buildResidentFinancialSummary({ admission, room: null, bed: null,
    bills: bills.filter(b => b.resident_id === admission.resident_id), payments: canonicalPayments });
  const outstanding = buildResidentFinancialSummary({ admission, room: null, bed: null, bills: current, payments: canonicalPayments }).monthlyRentDue;
  return <div className="mt-1 space-y-1 text-xs"><details><summary className="cursor-pointer">Monthly rent balances / Outstanding Rs{outstanding.toLocaleString("en-PK")}</summary>{current.sort((a,b) => String(a.billing_month).localeCompare(String(b.billing_month))).map(b => {
    const financial = buildResidentFinancialSummary({ admission, room: null, bed: null, bills: [b], payments: canonicalPayments });
    return <div key={String(b.id)}><p>{rentPeriodLabel(b.billing_month)}: Paid Rs{financial.rentPaid.toLocaleString("en-PK")} / Outstanding Rs{financial.monthlyRentDue.toLocaleString("en-PK")} / Due {String(b.due_date ?? "unavailable")}</p>
      {financial.monthlyRentDue > 0 && <BillPaymentActions billId={String(b.id)} month={b.billing_month} />}
    </div>;
  })}</details><p>Security Deposit: Paid Rs{deposit.depositPaid.toLocaleString("en-PK")} / Outstanding Rs{deposit.depositBalance.toLocaleString("en-PK")} / {String(admission.deposit_status ?? "unavailable")}</p></div>;
}
