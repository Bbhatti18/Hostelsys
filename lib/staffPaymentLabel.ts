import { allocatedPaymentLabel } from "./paymentReceiptPurpose";

export type StaffPaymentAllocation = { payment_id: string; bill_id: string; amount: number };

/** Display only: pending allocations describe purpose, never verified credit. */
export function staffPaymentLabel(payment: { id: string; resident_id: string; bill_id: string | null },
  allocations: StaffPaymentAllocation[], bills: Record<string, unknown>[]) {
  const residentBills = bills.filter(bill => bill.resident_id === payment.resident_id);
  const linked = allocations.filter(a => a.payment_id === payment.id && Number(a.amount) > 0 &&
    residentBills.some(bill => bill.id === a.bill_id));
  const reference = (bill: Record<string, unknown>) => String(bill.bill_number || `Bill ${String(bill.id).slice(0, 8)}`);
  if (linked.length) return allocatedPaymentLabel(linked, residentBills) ||
    [...new Set(linked.map(a => reference(residentBills.find(bill => bill.id === a.bill_id)!)))].join(" + ");
  const legacy = residentBills.find(bill => bill.id === payment.bill_id);
  return legacy ? legacy.bill_type === 'Rent' && legacy.billing_month ? allocatedPaymentLabel([{bill_id:String(legacy.id)}],residentBills) : reference(legacy) : "Unknown bill";
}
