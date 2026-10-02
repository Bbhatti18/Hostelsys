import { buildResidentFinancialSummary } from "./residentFinancialSummary";
import { paymentBillAmounts } from "./paymentAllocations";
import { roundMoney } from "./financialMath";
import { dashboardPayments } from "./dashboardRent";
import type { DashboardRow } from "./dashboardData";

const text = (value: unknown) => value == null ? "" : String(value);
const normalized = (value: unknown) => text(value).trim().toLowerCase();
const amount = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function dashboardVerifiedPaymentRevenue(
  payments: DashboardRow[],
  bills: DashboardRow[],
  lateFeeAllocations: DashboardRow[],
) {
  const billsById = new Map(bills.map(bill => [text(bill.id), bill]));
  const lateFeesByPayment = new Map<string, number>();
  for (const allocation of lateFeeAllocations) {
    if (!allocation.applied_at || allocation.reversed_at) continue;
    const paymentId = text(allocation.payment_id);
    if (!paymentId) continue;
    lateFeesByPayment.set(paymentId, roundMoney((lateFeesByPayment.get(paymentId) ?? 0) + Math.max(amount(allocation.amount), 0)));
  }

  return dashboardPayments(payments).flatMap(payment => {
    if (normalized(payment.payment_status) !== "verified") return [];
    const billRevenue = paymentBillAmounts({
      bill_id: text(payment.bill_id) || null,
      amount: amount(payment.amount),
      payment_status: "Verified",
    }, payment.allocations as Array<{ bill_id: string; amount: number }>).reduce((sum, allocation) => {
      const bill = billsById.get(text(allocation.bill_id));
      return normalized(bill?.bill_type) === "security deposit"
        ? sum
        : sum + Math.max(amount(allocation.amount), 0);
    }, 0);
    const lateFeeRevenue = lateFeesByPayment.get(text(payment.id)) ?? 0;
    const revenue = roundMoney(billRevenue + lateFeeRevenue);
    return revenue > 0 ? [{
      paymentId: text(payment.id),
      amount: revenue,
      date: text(payment.verified_at || payment.payment_date || payment.created_at),
    }] : [];
  });
}

export function dashboardOperatingRevenue(
  payments: DashboardRow[],
  bills: DashboardRow[],
  lateFeeAllocations: DashboardRow[],
) {
  return roundMoney(dashboardVerifiedPaymentRevenue(payments, bills, lateFeeAllocations)
    .reduce((sum, payment) => sum + payment.amount, 0));
}

/** Verified deposit principal still held, independent of whether its admission is historical. */
export function dashboardSecurityDepositsHeld(
  admissions: DashboardRow[],
  bills: DashboardRow[],
  payments: DashboardRow[],
) {
  const admissionsById = new Map(admissions.map(admission => [text(admission.id), admission]));
  const depositBills = new Map(bills.filter(bill =>
    normalized(bill.bill_type) === "security deposit" &&
    !["cancelled", "draft", "pending approval"].includes(normalized(bill.bill_status)) &&
    amount(bill.total_amount) > 0,
  ).map(bill => [text(bill.id), bill]));
  const heldByBill = new Map<string, number>();

  for (const payment of dashboardPayments(payments)) {
    if (normalized(payment.payment_status) !== "verified") continue;
    for (const allocation of paymentBillAmounts({
      bill_id: text(payment.bill_id) || null,
      amount: amount(payment.amount),
      payment_status: "Verified",
    }, payment.allocations as Array<{ bill_id: string; amount: number }>)) {
      const billId = text(allocation.bill_id);
      const bill = depositBills.get(billId);
      const admission = bill ? admissionsById.get(text(bill.admission_id)) : undefined;
      if (!bill || !admission || ["released", "deducted"].includes(normalized(admission.deposit_status))) continue;
      heldByBill.set(billId, roundMoney((heldByBill.get(billId) ?? 0) + Math.max(amount(allocation.amount), 0)));
    }
  }

  return roundMoney([...heldByBill.entries()].reduce((sum, [billId, paid]) => {
    return sum + Math.min(paid, amount(depositBills.get(billId)?.total_amount));
  }, 0));
}

export function dashboardCurrentAdmissionDues(
  admissions: DashboardRow[],
  bills: DashboardRow[],
  payments: DashboardRow[],
  lateFees: DashboardRow[],
) {
  const normalizedPayments = dashboardPayments(payments);
  const billsByAdmission = new Map<string, DashboardRow[]>();
  for (const bill of bills) {
    const admissionId = text(bill.admission_id);
    if (admissionId) billsByAdmission.set(admissionId, [...(billsByAdmission.get(admissionId) ?? []), bill]);
  }
  const lateFeesByBill = new Map<string, DashboardRow[]>();
  for (const fee of lateFees) {
    const billId = text(fee.bill_id);
    if (billId) lateFeesByBill.set(billId, [...(lateFeesByBill.get(billId) ?? []), fee]);
  }

  return roundMoney(admissions.filter(admission => ["pending", "active"].includes(normalized(admission.status)))
    .reduce((sum, admission) => {
      const admissionBills = billsByAdmission.get(text(admission.id)) ?? [];
      const summary = buildResidentFinancialSummary({
        admission,
        room: null,
        bed: null,
        bills: admissionBills,
        payments: normalizedPayments,
      });
      const payableRentBillIds = new Set(admissionBills.filter(bill =>
        normalized(bill.bill_type) === "rent" &&
        !["cancelled", "draft", "pending approval"].includes(normalized(bill.bill_status)),
      ).map(bill => text(bill.id)));
      const payableLateFee = [...payableRentBillIds].flatMap(billId => lateFeesByBill.get(billId) ?? [])
        .filter(fee => !["paid", "waived"].includes(normalized(fee.status)))
        .reduce((feeSum, fee) => feeSum + Math.max(amount(fee.payable_amount), 0), 0);
      return sum + summary.totalOutstanding + payableLateFee;
    }, 0));
}
