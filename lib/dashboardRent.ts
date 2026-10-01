import { buildResidentFinancialSummary } from "./residentFinancialSummary";
import type { DashboardData, DashboardRow } from "./dashboardData";

export function karachiCalendarDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** Normalize the SDK relation once; allocations supersede legacy bill_id credit. */
export function dashboardPayments(payments: DashboardRow[]) {
  return [...new Map<string, DashboardRow & { allocations: DashboardRow[] }>(payments.filter(p => p.id).map(p => [String(p.id), {
    ...p, allocations: Array.isArray(p.allocations) ? p.allocations :
      Array.isArray(p.payment_allocations) ? p.payment_allocations : [],
  }])).values()];
}

export function currentPayableDashboardBills(data: DashboardData, today: string) {
  const latest = new Map<string, DashboardRow>();
  const key = (a: DashboardRow) => `${a.admission_date ?? ""}/${a.created_at ?? ""}/${a.id ?? ""}`;
  for (const admission of data.admissions) {
    const residentId = String(admission.resident_id ?? "");
    const previous = latest.get(residentId);
    if (!previous || key(admission) > key(previous)) latest.set(residentId, admission);
  }
  const residents = new Map(data.residents.map(r => [String(r.id), r]));
  return [...new Map(data.bills.filter(bill => {
    const admission = latest.get(String(bill.resident_id));
    const resident = residents.get(String(bill.resident_id));
    return bill.id && admission && resident &&
      !["Archived", "Checked Out", "Inactive"].includes(String(resident.status)) &&
      admission.id === bill.admission_id && ["Pending", "Active"].includes(String(admission.status)) &&
      String(admission.admission_date ?? "") !== "" && String(admission.admission_date) <= today &&
      String(bill.due_date ?? "") >= String(admission.admission_date) &&
      ["Pending", "Partially Paid", "Overdue"].includes(String(bill.bill_status));
  }).map(bill => [String(bill.id), bill])).values()];
}

export function buildDashboardRent(data: DashboardData, now = new Date()) {
  const today = karachiCalendarDate(now);
  const payments = dashboardPayments(data.payments);
  const admissions = new Map(data.admissions.map(a => [String(a.id), a]));
  const residents = new Map(data.residents.map(r => [String(r.id), r]));
  const rooms = new Map(data.rooms.map(r => [String(r.id), r]));
  const beds = new Map(data.beds.map(b => [String(b.id), b]));
  const outstanding = currentPayableDashboardBills(data, today)
    .filter(bill => bill.bill_type === "Rent")
    .flatMap(bill => {
      const admission = admissions.get(String(bill.admission_id))!;
      const residentPayments = payments.filter(p => p.resident_id === bill.resident_id);
      // One real bill, so the canonical helper cannot synthesize unbilled rent or
      // mix cycles. It retains proportional discounts and rent-first allocation.
      const financial = buildResidentFinancialSummary({
        admission, room: null, bed: null, bills: [bill], payments: residentPayments,
      });
      if (!(financial.monthlyRentDue > 0)) return [];
      const linkedPayments = residentPayments.filter(p => p.allocations.length
        ? p.allocations.some((a: DashboardRow) => a.bill_id === bill.id)
        : p.bill_id === bill.id);
      const pending = linkedPayments.some(p => p.payment_status === "Pending") || data.receipts.some(receipt => {
        if (receipt.resident_id !== bill.resident_id || receipt.status !== "Pending Verification") return false;
        const parent = payments.find(p => p.id === receipt.payment_id);
        if (receipt.payment_id && (!parent || parent.payment_status !== "Pending")) return false;
        return receipt.bill_id === bill.id || linkedPayments.some(p => p.id === receipt.payment_id);
      });
      const bed = beds.get(String(admission.bed_id));
      return [{
        billId: String(bill.id), residentId: String(bill.resident_id),
        residentName: String(residents.get(String(bill.resident_id))?.full_name || "Resident"),
        room: String(rooms.get(String(admission.room_id))?.room_number || "Not allocated"),
        bed: bed && bed.room_id === admission.room_id ? String(bed.bed_number ?? "") : "",
        rentAmount: financial.rentCharges, outstandingAmount: financial.monthlyRentDue,
        dueDate: String(bill.due_date),
        paymentState: pending ? "Payment Pending Verification" : "Due",
        href: pending ? "/payment-verification" : "/billing?type=Rent",
      }];
    }).sort((a, b) => a.residentName.localeCompare(b.residentName) || a.billId.localeCompare(b.billId));
  return { today, outstanding, dueToday: outstanding.filter(bill => bill.dueDate === today) };
}
