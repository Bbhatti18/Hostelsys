import { deriveBillStatus, roundMoney, type BillLifecycleStatus } from "./financialMath";
import { paymentBillAmounts } from "./paymentAllocations";

export type FinancialRow = Record<string, unknown>;

export type FinancialLineItem = {
  id: string;
  title: string;
  amount: number;
  dueDate: string | null;
  status: BillLifecycleStatus;
  month: string;
};

export type ResidentFinancialSummary = {
  monthlyRent: number;
  monthlyRentDue: number;
  rentDueDate: string | null;
  rentStatus: BillLifecycleStatus | "Not Billed";
  depositRequired: number;
  depositPaid: number;
  depositBalance: number;
  depositStatus: string;
  utilityItems: FinancialLineItem[];
  otherItems: FinancialLineItem[];
  rentCharges: number;
  rentPaid: number;
  utilityCharges: number;
  otherCharges: number;
  discountApplied: number;
  totalCharges: number;
  verifiedPayments: number;
  appliedPayments: number;
  totalOutstanding: number;
  paymentDeadline: string | null;
  accountStatus: "Paid" | "Pending" | "Overdue";
};

function numberValue(...values: unknown[]) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && value !== null && value !== undefined && value !== "") return parsed;
  }
  return 0;
}

function billNumber(row: FinancialRow, primary: string) {
  const primaryValue = row[primary];
  if (primaryValue !== null && primaryValue !== undefined && String(primaryValue).trim() !== "") {
    const parsed = Number(primaryValue);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function value(row: FinancialRow | null | undefined, ...keys: string[]) {
  for (const key of keys) {
    const candidate = row?.[key];
    if (candidate !== null && candidate !== undefined && String(candidate).trim()) return candidate;
  }
  return null;
}

function normalized(input: unknown) {
  return String(input ?? "").trim().toLowerCase();
}

function monthValue(input: unknown) {
  return String(input ?? "").slice(0, 7);
}

function isReceivedDeposit(status: unknown) {
  return normalized(status) === "held";
}

function isSecurityDepositBillRow(row: FinancialRow) {
  return (
    normalized(value(row, "bill_type")) === "security deposit"
  );
}

export function buildResidentFinancialSummary({
  admission,
  room,
  bills,
  payments,
}: {
  admission: FinancialRow | null;
  room: FinancialRow | null;
  bed: FinancialRow | null;
  bills: FinancialRow[];
  payments: FinancialRow[];
}): ResidentFinancialSummary {
  // No current admission means no current account obligations.
  if (!admission?.id || !["Pending", "Active"].includes(String(admission.status))) {
    admission = null;
    room = null;
    bills = [];
  }
  const admissionBills = bills.filter(bill => admission && String(bill.admission_id ?? "") === String(admission.id));
  const verifiedByBill = new Map<string, number>();
  for (const payment of payments) {
    if (normalized(value(payment, "payment_status")) !== "verified") continue;
    const allocations = Array.isArray(payment.allocations)
      ? payment.allocations.filter((allocation): allocation is FinancialRow => Boolean(allocation && typeof allocation === "object"))
      : [];
    for (const allocation of paymentBillAmounts(payment, allocations as Array<{ bill_id: string; amount: number }>)) {
      if (!allocation.bill_id) continue;
      verifiedByBill.set(
        allocation.bill_id,
        roundMoney((verifiedByBill.get(allocation.bill_id) ?? 0) + numberValue(allocation.amount)),
      );
    }
  }

  const activeBills = admissionBills
    .filter((bill) => !["cancelled", "draft", "pending approval"].includes(normalized(bill.bill_status)))
    .filter((bill) => !admission || String(bill.admission_id ?? "") === String(admission.id))
    .map((bill) => {
      const id = String(bill.id ?? "");
      const total = roundMoney(numberValue(bill.total_amount));
      const verifiedPaid = verifiedByBill.get(id) ?? 0;
      const appliedPaid = Math.min(verifiedPaid, total);
      const balance = Math.max(roundMoney(total - appliedPaid), 0);
      const dueDate = (balance > 0 && value(bill, "remaining_payment_date"))
        ? String(value(bill, "remaining_payment_date")).slice(0, 10)
        : value(bill, "due_date")
          ? String(value(bill, "due_date")).slice(0, 10)
          : null;
      const status = deriveBillStatus(total, appliedPaid, dueDate, String(value(bill, "bill_status") ?? ""));
      return { bill, id, total, verifiedPaid, appliedPaid, balance, dueDate, status, month: monthValue(bill.billing_month) };
    })
    .sort((a, b) => b.month.localeCompare(a.month));

  const depositBillItem = activeBills.find((item) => isSecurityDepositBillRow(item.bill)) ?? null;
  const regularBillItems = activeBills.filter((item) => !isSecurityDepositBillRow(item.bill));

  let rentDue = 0;
  let rentOverdue = false;
  let rentCharges = 0;
  let rentPaid = 0;
  let utilityCharges = 0;
  let otherCharges = 0;
  let discountApplied = 0;
  const unpaidRentDeadlines: string[] = [];
  const utilityItems: FinancialLineItem[] = [];
  const otherItems: FinancialLineItem[] = [];

  for (const item of regularBillItems) {
    let paymentRemaining = item.appliedPaid;
    const rent = roundMoney(billNumber(item.bill, "rent_amount"));
    const electricity = roundMoney(billNumber(item.bill, "electricity_amount"));
    const ac = roundMoney(billNumber(item.bill, "ac_amount"));
    const maintenance = 0;
    let other = roundMoney(billNumber(item.bill, "other_amount"));
    const recordedDiscount = Math.max(roundMoney(billNumber(item.bill, "discount_amount")), 0);
    const knownGross = roundMoney(rent + electricity + ac + maintenance + other);
    const expectedNet = Math.max(roundMoney(knownGross - recordedDiscount), 0);
    const missingChargeAdjustment = Math.max(roundMoney(item.total - expectedNet), 0);
    other = Math.max(roundMoney(other + missingChargeAdjustment), 0);
    const gross = roundMoney(rent + electricity + ac + maintenance + other);
    const effectiveDiscount = Math.max(roundMoney(gross - item.total), 0);
    const netFactor = gross > 0 ? Math.max((gross - effectiveDiscount) / gross, 0) : 0;
    const netRent = roundMoney(rent * netFactor);
    const netElectricity = roundMoney(electricity * netFactor);
    const netAc = roundMoney(ac * netFactor);
    const netMaintenance = roundMoney(maintenance * netFactor);
    const allocatedBeforeOther = roundMoney(netRent + netElectricity + netAc + netMaintenance);
    const netOther = Math.max(roundMoney(item.total - allocatedBeforeOther), 0);

    rentCharges += rent;
    utilityCharges += electricity + ac;
    otherCharges += maintenance + other;
    discountApplied += effectiveDiscount;

    const rentOutstanding = Math.max(roundMoney(netRent - paymentRemaining), 0);
    rentPaid += Math.min(netRent, paymentRemaining);
    paymentRemaining = Math.max(roundMoney(paymentRemaining - netRent), 0);
    rentDue += rentOutstanding;
    if (rentOutstanding > 0) {
      if (item.status === "Overdue") rentOverdue = true;
      if (item.dueDate) unpaidRentDeadlines.push(item.dueDate);
    }

    for (const [kind, grossAmount, netAmount] of [["Electricity", electricity, netElectricity], ["AC charges", ac, netAc]] as const) {
      if (grossAmount <= 0) continue;
      const outstanding = Math.max(roundMoney(netAmount - paymentRemaining), 0);
      paymentRemaining = Math.max(roundMoney(paymentRemaining - netAmount), 0);
      utilityItems.push({ id: `${item.id}-${kind}`, title: `${kind} · ${item.month || "Bill"}`, amount: outstanding, dueDate: item.dueDate, status: outstanding === 0 ? "Paid" : item.status, month: item.month });
    }

    for (const [kind, grossAmount, netAmount] of [["Maintenance charges", maintenance, netMaintenance], ["Other charges", other, netOther]] as const) {
      if (grossAmount <= 0) continue;
      const outstanding = Math.max(roundMoney(netAmount - paymentRemaining), 0);
      paymentRemaining = Math.max(roundMoney(paymentRemaining - netAmount), 0);
      otherItems.push({ id: `${item.id}-${kind}`, title: `${kind} · ${item.month || "Bill"}`, amount: outstanding, dueDate: item.dueDate, status: outstanding === 0 ? "Paid" : item.status, month: item.month });
    }
  }

  const currentBill = regularBillItems[0] ?? null;
  const monthlyRent = currentBill
    ? roundMoney(numberValue(currentBill.bill.rent_amount))
    : roundMoney(numberValue(admission?.monthly_rent, room?.monthly_rent));
  const depositRequired = depositBillItem
    ? depositBillItem.total
    : roundMoney(numberValue(admission?.security_deposit));
  const depositReceived = isReceivedDeposit(value(admission, "deposit_status"));
  // Ledger evidence wins over a cached Held flag, including reversals. A Held
  // balance without ledger evidence is retained only for this exact admission.
  const depositIds = new Set(admissionBills.filter(isSecurityDepositBillRow).map(bill => String(bill.id)));
  const hasDepositLedger = payments.some(payment => {
    const allocations = Array.isArray(payment.allocations)
      ? payment.allocations.filter((allocation): allocation is FinancialRow => Boolean(allocation && typeof allocation === "object"))
      : [];
    const ledgerRows = allocations.length
      ? allocations
      : payment.bill_id
        ? [{ bill_id: String(payment.bill_id) }]
        : [];
    return ledgerRows
      .some(allocation => depositIds.has(String(allocation.bill_id)));
  }) ||
    admissionBills.some(bill => isSecurityDepositBillRow(bill) && normalized(bill.bill_status) === "cancelled");
  const depositPaid = hasDepositLedger ? (depositBillItem?.appliedPaid ?? 0) : depositReceived ? depositRequired : (depositBillItem?.appliedPaid ?? 0);
  const depositBalance = Math.max(roundMoney(depositRequired - depositPaid), 0);
  const depositStatus =
    depositBalance === 0 && depositRequired > 0
      ? "Held"
      : String(
          (depositBalance > 0 ? "Pending" : value(admission, "deposit_status")) ??
            (depositRequired > 0 ? "Pending" : "Not required"),
        );

  // Admission rent remains due before its first released bill. Never create a fake bill ID.
  const unbilledRent = !currentBill && admission && ["Pending", "Active"].includes(String(admission.status)) ? monthlyRent : 0;
  rentDue += unbilledRent;
  rentCharges += unbilledRent;
  const totalCharges = roundMoney(
    regularBillItems.reduce((sum, item) => sum + item.total, 0) + depositRequired + unbilledRent,
  );
  const verifiedPayments = roundMoney(
    regularBillItems.reduce((sum, item) => sum + item.verifiedPaid, 0) + depositPaid,
  );
  const appliedPayments = roundMoney(
    regularBillItems.reduce((sum, item) => sum + item.appliedPaid, 0) + depositPaid,
  );
  const totalOutstanding = roundMoney(
    regularBillItems.reduce((sum, item) => sum + item.balance, 0) + depositBalance + unbilledRent,
  );
  const outstandingBills = regularBillItems.filter((item) => item.balance > 0);
  const deadlines = [
    ...outstandingBills.map((item) => item.dueDate),
    depositBalance > 0 && depositBillItem?.dueDate ? depositBillItem.dueDate : null,
  ]
    .filter((date): date is string => Boolean(date))
    .sort();
  const accountStatus =
    outstandingBills.some((item) => item.status === "Overdue") ||
    (depositBalance > 0 && depositBillItem?.status === "Overdue")
      ? "Overdue"
      : totalOutstanding > 0
        ? "Pending"
        : "Paid";

  return {
    monthlyRent,
    monthlyRentDue: roundMoney(rentDue),
    rentDueDate: unpaidRentDeadlines.sort()[0] ?? null,
    rentStatus: !currentBill ? "Not Billed" : rentDue === 0 ? "Paid" : rentOverdue ? "Overdue" : "Pending",
    depositRequired,
    depositPaid,
    depositBalance: Math.max(roundMoney(depositRequired - depositPaid), 0),
    depositStatus,
    utilityItems,
    otherItems,
    rentCharges: roundMoney(rentCharges),
    rentPaid: roundMoney(rentPaid),
    utilityCharges: roundMoney(utilityCharges),
    otherCharges: roundMoney(otherCharges),
    discountApplied: roundMoney(discountApplied),
    totalCharges,
    verifiedPayments,
    appliedPayments,
    totalOutstanding,
    paymentDeadline: deadlines[0] ?? null,
    accountStatus,
  };
}
