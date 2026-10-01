import { paymentBillAmounts } from "./paymentAllocations";

export type DepositState = "not_required" | "pending" | "verified";
type DepositRow = Record<string, unknown>;

/** Read-only evidence for this admission; cached Held/balance flags are not proof. */
export function getAdmissionDeposit(
  admission: DepositRow | null | undefined,
  bills: DepositRow[] | undefined,
  payments: DepositRow[] | undefined,
): { state: DepositState; required: number } {
  const declared = Number(admission?.security_deposit);
  const deposits = (bills ?? []).filter(b => b.admission_id === admission?.id &&
    b.bill_type === "Security Deposit" && b.bill_status !== "Cancelled" &&
    (!admission?.resident_id || b.resident_id === admission.resident_id));
  const required = Math.max(0, ...deposits.map(b => Number(b.total_amount) || 0), Number.isFinite(declared) ? declared : 0);
  if (!admission?.id || !bills || !payments) return { state: "pending", required };
  if (required === 0 && admission.security_deposit != null && String(admission.security_deposit).trim() !== "" && declared === 0) {
    return { state: "not_required", required };
  }
  if (required <= 0 || deposits.length !== 1) return { state: "pending", required };
  const bill = deposits[0];
  if (!(Number(bill.total_amount) > 0)) return { state: "pending", required };
  if (!["Pending", "Partially Paid", "Overdue", "Paid"].includes(String(bill.bill_status))) return { state: "pending", required };
  let paid = 0;
  for (const payment of payments) {
    if (admission.resident_id && payment.resident_id !== admission.resident_id) continue;
    const allocations = (Array.isArray(payment.allocations) ? payment.allocations :
      Array.isArray(payment.payment_allocations) ? payment.payment_allocations : []) as Array<{ bill_id: string; amount: number }>;
    const amounts = paymentBillAmounts({ bill_id: payment.bill_id as string | null,
      payment_status: String(payment.payment_status), amount: Number(payment.amount) }, allocations);
    paid += amounts.filter(a => a.bill_id === bill.id).reduce((sum, a) => sum + Math.max(0, Number(a.amount) || 0), 0);
  }
  return { state: Math.round(paid * 100) >= Math.round(required * 100) ? "verified" : "pending", required };
}

export function depositStateLabel(state: DepositState) {
  return state === "not_required" ? "No Deposit Required" : state === "verified" ? "Deposit Verified" : "Deposit Pending";
}

export type ContractReadinessRecord = {
  status?: string | null;
  resident_signature_url?: string | null;
  resident_signature_status?: string | null;
  signed_by_resident?: boolean | null;
  signed_at?: string | null;
  contract_content?: string | null;
};

export function getContractTerms(contract: ContractReadinessRecord) {
  return (contract.contract_content || "").trim();
}

export function hasResidentSignature(contract: ContractReadinessRecord) {
  return Boolean(
    (contract.resident_signature_url) &&
      ["Submitted", "Approved", "Signed"].includes(
        contract.resident_signature_status ?? "",
      ) &&
      contract.signed_by_resident &&
      contract.signed_at,
  );
}

export function isResidentSignatureApproved(
  contract: ContractReadinessRecord | null | undefined,
) {
  return Boolean(
    contract &&
      contract.resident_signature_status === "Approved" &&
      hasResidentSignature(contract),
  );
}

export function isContractSignedAndAccepted(
  contract: ContractReadinessRecord | null | undefined,
) {
  return Boolean(
    contract &&
      ["Pending Signature", "Active"].includes(contract.status ?? "") &&
      isResidentSignatureApproved(contract) &&
      getContractTerms(contract),
  );
}

export function isDepositVerified(state: DepositState) {
  return state === "verified";
}

export function isAdmissionReadyForActivation(
  depositStatus: DepositState,
  contract: ContractReadinessRecord | null | undefined,
) {
  return contract?.status === "Pending Signature" && (depositStatus === "not_required" || isDepositVerified(depositStatus)) && isContractSignedAndAccepted(contract);
}

/** Shared read-only Ready predicate; staff authorization remains in the action. */
export function isAdmissionActivationReady({
  admission, resident, room, bed, contract, depositState, admissions,
}: {
  admission: DepositRow;
  resident: DepositRow | null | undefined;
  room: DepositRow | null | undefined;
  bed: DepositRow | null | undefined;
  contract: (ContractReadinessRecord & { admission_id?: unknown }) | null | undefined;
  depositState: DepositState;
  admissions: DepositRow[];
}) {
  return Boolean(
    admission.id && admission.status === "Pending" &&
    resident?.id && resident.id === admission.resident_id && resident.status !== "Archived" &&
    room?.id && room.id === admission.room_id &&
    ["Available", "Partially Occupied", "Occupied"].includes(String(room.status)) &&
    bed?.id && bed.id === admission.bed_id && bed.room_id === room.id && bed.status === "Occupied" &&
    contract?.admission_id === admission.id &&
    isAdmissionReadyForActivation(depositState, contract) &&
    !admissions.some(other => other.id !== admission.id && other.bed_id === admission.bed_id &&
      ["Pending", "Active"].includes(String(other.status))),
  );
}
