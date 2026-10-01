import { validDate } from "@/lib/canonical";
import { getAdmissionDeposit, isAdmissionActivationReady, isContractSignedAndAccepted } from "@/lib/contractWorkflow";
import { deriveBillStatus, roundMoney } from "@/lib/financialMath";
import { paymentBillAmounts } from "@/lib/paymentAllocations";
import { buildDashboardRent, currentPayableDashboardBills, dashboardPayments, karachiCalendarDate } from "./dashboardRent";

export type DashboardRow = Record<string, unknown>;

export type DashboardData = {
  residents: DashboardRow[];
  admissions: DashboardRow[];
  contracts: DashboardRow[];
  bills: DashboardRow[];
  payments: DashboardRow[];
  receipts: DashboardRow[];
  rooms: DashboardRow[];
  beds: DashboardRow[];
  maintenance: DashboardRow[];
  inspections: DashboardRow[];
  notices: DashboardRow[];
};

export type DashboardTask = {
  id: string;
  label: string;
  count: number;
  href: string;
  priority: number;
  tone: "red" | "amber" | "blue" | "slate";
};

export type DashboardActivity = {
  id: string;
  description: string;
  occurredAt: string;
  href: string;
  tone: "blue" | "green" | "purple" | "orange" | "slate";
};

const text = (value: unknown) => value == null ? "" : String(value).trim();
const normalized = (value: unknown) => text(value).toLowerCase();
const number = (value: unknown) => Number(value ?? 0);

function localDay(date: Date) {
  return karachiCalendarDate(date);
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return localDay(result);
}

function task(
  id: string,
  count: number,
  singular: string,
  plural: string,
  href: string,
  priority: number,
  tone: DashboardTask["tone"],
) {
  return count > 0
    ? { id, count, label: count === 1 ? singular : plural, href, priority, tone }
    : null;
}

function residentName(row: DashboardRow | undefined) {
  return text(row?.full_name) || text(row?.resident_code) || "Resident";
}

function event(
  id: string,
  description: string,
  occurredAt: unknown,
  href: string,
  tone: DashboardActivity["tone"],
) {
  const timestamp = text(occurredAt);
  return timestamp ? { id, description, occurredAt: timestamp, href, tone } : null;
}

export function buildDashboardSummary(data: DashboardData, now = new Date()) {
  const today = localDay(now);
  const nextSevenDays = addDays(now, 7);
  const residentsById = new Map(
    data.residents.map((resident) => [text(resident.id), resident]),
  );
  const contractsByAdmission = new Map<string, DashboardRow>();
  const roomsById = new Map(
    data.rooms.map((room) => [text(room.id), room]),
  );
  const bedsById = new Map(
    data.beds.map((bed) => [text(bed.id), bed]),
  );

  [...data.contracts]
    .sort((left, right) => text(right.created_at).localeCompare(text(left.created_at)))
    .forEach((contract) => {
      const admissionId = text(contract.admission_id);
      if (admissionId && !contractsByAdmission.has(admissionId)) {
        contractsByAdmission.set(admissionId, contract);
      }
    });

  const operationalContracts = data.contracts.filter(
    (contract) => !["cancelled", "terminated", "expired", "archived"].includes(
      normalized(contract.status),
    ),
  );
  const pendingSignatureContracts = operationalContracts.filter(
    (contract) =>
      normalized(contract.status) === "pending signature" &&
      !isContractSignedAndAccepted(contract),
  );
  const signedAwaitingApproval = operationalContracts.filter(
    (contract) =>
      ["submitted", "signed"].includes(normalized(contract.resident_signature_status)) &&
      !isContractSignedAndAccepted(contract),
  );

  const pendingAdmissions = data.admissions.filter(
    (admission) => normalized(admission.status) === "pending",
  );
  const pendingDeposits = pendingAdmissions.filter(
    (admission) => getAdmissionDeposit(admission, data.bills, data.payments).state === "pending",
  );
  const readyForActivation = pendingAdmissions.filter((admission) => {
    const room = roomsById.get(text(admission.room_id));
    const bed = bedsById.get(text(admission.bed_id));
    const resident = residentsById.get(text(admission.resident_id));
    return isAdmissionActivationReady({
      admission, resident, room, bed,
      contract: contractsByAdmission.get(text(admission.id)),
      depositState: getAdmissionDeposit(admission, data.bills, data.payments).state,
      admissions: data.admissions, bills: data.bills, payments: data.payments,
    });
  });
  const blockedByContractApproval = pendingAdmissions.filter((admission) => {
    const contract = contractsByAdmission.get(text(admission.id));
    return (
      getAdmissionDeposit(admission, data.bills, data.payments).state !== "pending" &&
      Boolean(contract) &&
      ["submitted", "signed"].includes(
        normalized(contract?.resident_signature_status),
      ) &&
      !isContractSignedAndAccepted(contract)
    );
  });
  const upcomingCheckouts = data.admissions.filter((admission) => {
    const leavingDate = text(admission.expected_leaving_date).slice(0, 10);
    return (
      ["pending", "active"].includes(normalized(admission.status)) &&
      leavingDate >= today &&
      leavingDate <= nextSevenDays
    );
  });

  const verifiedByBill = new Map<string, number>();
  dashboardPayments(data.payments).forEach((payment) => {
    if (normalized(payment.payment_status) !== "verified") return;
    for (const allocation of paymentBillAmounts({
      bill_id: text(payment.bill_id), amount: number(payment.amount), payment_status: text(payment.payment_status),
    }, payment.allocations as Array<{ bill_id: string; amount: number }>)) {
      const billId = text(allocation.bill_id);
      if (!billId) continue;
      verifiedByBill.set(billId, roundMoney((verifiedByBill.get(billId) ?? 0) + number(allocation.amount)));
    }
  });

  const outstandingBills = currentPayableDashboardBills(data, today)
    .map((bill) => {
      const total = roundMoney(number(bill.total_amount));
      const paid = verifiedByBill.get(text(bill.id)) ?? 0;
      const balance = Math.max(roundMoney(total - paid), 0);
      return {
        bill,
        balance,
        status: deriveBillStatus(total, paid, text(bill.due_date), text(bill.bill_status)),
        dueDate: text(bill.due_date).slice(0, 10),
      };
    })
    .filter(({ balance }) => balance > 0);
  const overdueBills = outstandingBills.filter(
    ({ dueDate }) => Boolean(dueDate) && dueDate < today,
  );
  const rent = buildDashboardRent(data, now);
  const pendingRentBills = rent.outstanding.filter(({ dueDate }) => dueDate >= today);
  const approachingBills = outstandingBills.filter(
    ({ dueDate }) => Boolean(dueDate) && dueDate >= today && dueDate <= nextSevenDays,
  );

  const pendingReceipts = data.receipts.filter(
    (receipt) => normalized(receipt.status) === "pending verification",
  );
  const unresolvedMaintenance = data.maintenance.filter((request) =>
    ["open", "pending", "in progress"].includes(normalized(request.status)),
  );
  const highPriorityMaintenance = unresolvedMaintenance.filter((request) =>
    ["high", "emergency"].includes(normalized(request.priority)),
  );
  const openMaintenance = unresolvedMaintenance.filter((request) =>
    ["open", "pending"].includes(normalized(request.status)),
  );
  const inProgressMaintenance = unresolvedMaintenance.filter(
    (request) => normalized(request.status) === "in progress",
  );
  const draftNotices = data.notices.filter(
    (notice) => normalized(notice.status) === "draft",
  );
  const expiringNotices = data.notices.filter((notice) => {
    const expiryDate = text(notice.expiry_date).slice(0, 10);
    return (
      ["published"].includes(normalized(notice.status)) &&
      validDate(notice.publish_date) && notice.publish_date <= today &&
      validDate(expiryDate) &&
      Boolean(expiryDate) &&
      expiryDate >= today &&
      expiryDate <= nextSevenDays
    );
  });

  const tasks = [
    task("pending-receipts", pendingReceipts.length, "payment waiting for verification", "payments waiting for verification", "/payment-verification", 100, "red"),
    task("overdue-bills", overdueBills.length, "overdue bill", "overdue bills", "/billing", 95, "red"),
    task("high-maintenance", highPriorityMaintenance.length, "high-priority maintenance request", "high-priority maintenance requests", "/maintenance", 90, "red"),
    task("signed-contracts", signedAwaitingApproval.length, "signed contract waiting for approval", "signed contracts waiting for approval", "/contracts", 85, "amber"),
    task("contract-blocked", blockedByContractApproval.length, "admission blocked by contract approval", "admissions blocked by contract approval", "/admissions", 84, "amber"),
    task("ready-admissions", readyForActivation.length, "pending admission ready for activation", "pending admissions ready for activation", "/admissions", 80, "blue"),
    task("pending-deposits", pendingDeposits.length, "pending admission needs deposit verification", "pending admissions need deposit verification", "/admissions", 75, "amber"),
    task("pending-signatures", pendingSignatureContracts.length, "contract waiting for resident signature", "contracts waiting for resident signatures", "/contracts", 70, "amber"),
    task("open-maintenance", openMaintenance.length, "open maintenance request", "open maintenance requests", "/maintenance", 60, "slate"),
    task("in-progress-maintenance", inProgressMaintenance.length, "maintenance request in progress", "maintenance requests in progress", "/maintenance", 55, "blue"),
    task("upcoming-checkouts", upcomingCheckouts.length, "resident check-out due within 7 days", "resident check-outs due within 7 days", "/admissions", 50, "amber"),
    task("approaching-bills", approachingBills.length, "bill due within 7 days", "bills due within 7 days", "/billing", 45, "blue"),
    task("pending-rent", pendingRentBills.length, "pending rent bill", "pending rent bills", "/billing", 40, "slate"),
    task("draft-notices", draftNotices.length, "draft notice awaiting publication", "draft notices awaiting publication", "/notices", 30, "slate"),
    task("expiring-notices", expiringNotices.length, "published notice expiring within 7 days", "published notices expiring within 7 days", "/notices", 25, "slate"),
  ].filter((item): item is DashboardTask => Boolean(item))
    .sort((left, right) => right.priority - left.priority);

  const activities: DashboardActivity[] = [];
  const push = (item: DashboardActivity | null) => { if (item) activities.push(item); };

  data.residents.forEach((resident) => push(event(
    `resident-${text(resident.id)}`,
    `${residentName(resident)} resident profile created`,
    resident.created_at,
    "/residents",
    "blue",
  )));
  data.admissions.forEach((admission) => {
    const name = residentName(residentsById.get(text(admission.resident_id)));
    const status = normalized(admission.status);
    const action = status === "pending" ? "created" : status || "created";
    push(event(`admission-${text(admission.id)}`, `${name} admission ${action}`, admission.updated_at || admission.created_at, "/admissions", "blue"));
  });
  data.contracts.forEach((contract) => {
    const name = residentName(residentsById.get(text(contract.resident_id)));
    const signatureStatus = normalized(contract.resident_signature_status);
    const description = normalized(contract.status) === "active"
      ? `${name} contract activated`
      : signatureStatus === "approved"
        ? `${name} contract signature approved`
        : ["submitted", "signed"].includes(signatureStatus)
          ? `${name} contract signed by resident`
          : `${name} contract created`;
    push(event(`contract-${text(contract.id)}`, description, contract.signed_at || contract.updated_at || contract.created_at, "/contracts", "purple"));
  });
  data.bills.forEach((bill) => {
    const name = residentName(residentsById.get(text(bill.resident_id)));
    const total = roundMoney(number(bill.total_amount));
    const balance = Math.max(roundMoney(total - (verifiedByBill.get(text(bill.id)) ?? 0)), 0);
    const description = normalized(bill.bill_status) === "cancelled"
      ? `${name} bill cancelled`
      : total > 0 && balance === 0
        ? `${name} bill paid`
        : `${name} bill created`;
    push(event(`bill-${text(bill.id)}`, description, bill.updated_at || bill.created_at, "/billing", "green"));
  });
  data.payments.forEach((payment) => {
    const name = residentName(residentsById.get(text(payment.resident_id)));
    const status = normalized(payment.payment_status);
    const description = status === "verified" ? `${name} payment verified` : status === "rejected" ? `${name} payment rejected` : `${name} payment submitted`;
    push(event(`payment-${text(payment.id)}`, description, payment.verified_at || payment.updated_at || payment.created_at, "/payments", "green"));
  });
  data.receipts.filter((receipt) => normalized(receipt.status) !== "verified").forEach((receipt) => {
    const name = residentName(residentsById.get(text(receipt.resident_id)));
    const description = normalized(receipt.status) === "rejected" ? `${name} receipt rejected` : `${name} receipt submitted for verification`;
    push(event(`receipt-${text(receipt.id)}`, description, receipt.updated_at || receipt.created_at, "/payment-verification", "green"));
  });
  data.inspections.forEach((inspection) => {
    const name = residentName(residentsById.get(text(inspection.resident_id)));
    push(event(`inspection-${text(inspection.id)}`, `${name} ${text(inspection.inspection_type) || "room"} inspection completed`, inspection.updated_at || inspection.created_at || inspection.inspection_date, `/inspection/${text(inspection.id)}`, "orange"));
  });
  data.maintenance.forEach((request) => {
    const status = normalized(request.status);
    const label = text(request.request_number) || text(request.title) || "Maintenance request";
    const description = status === "completed" ? `${label} completed` : status === "in progress" ? `${label} moved to in progress` : status === "cancelled" ? `${label} cancelled` : status === "archived" ? `${label} archived` : `${label} created`;
    push(event(`maintenance-${text(request.id)}`, description, request.completed_at || request.updated_at || request.created_at, `/maintenance/${text(request.id)}`, "orange"));
  });
  data.notices.forEach((notice) => {
    const status = normalized(notice.status);
    const title = text(notice.title) || "Notice";
    const description = status === "published" ? `Notice published: ${title}` : status === "archived" ? `Notice archived: ${title}` : status === "draft" ? `Notice drafted: ${title}` : `Notice ${status || "updated"}: ${title}`;
    push(event(`notice-${text(notice.id)}`, description, notice.updated_at || notice.created_at, `/notices/${text(notice.id)}`, "slate"));
  });

  activities.sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));

  return {
    rentDueToday: rent.dueToday,
    today,
    tasks,
    activities: activities.slice(0, 12),
    diagnostics: {
      pendingReceipts: pendingReceipts.length,
      overdueBills: overdueBills.length,
      pendingRentBills: pendingRentBills.length,
      pendingSignatureContracts: pendingSignatureContracts.length,
      signedAwaitingApproval: signedAwaitingApproval.length,
      pendingDeposits: pendingDeposits.length,
      readyForActivation: readyForActivation.length,
      blockedByContractApproval: blockedByContractApproval.length,
      openMaintenance: openMaintenance.length,
      inProgressMaintenance: inProgressMaintenance.length,
      highPriorityMaintenance: highPriorityMaintenance.length,
      upcomingCheckouts: upcomingCheckouts.length,
      draftNotices: draftNotices.length,
      expiringNotices: expiringNotices.length,
    },
  };
}
