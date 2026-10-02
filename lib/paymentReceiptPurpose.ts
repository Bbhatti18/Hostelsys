export const SECURITY_DEPOSIT_PURPOSE = "Security Deposit";

const PURPOSE_PREFIX = "Payment purpose:";
const ADMISSION_PREFIX = "Admission ID:";

export function securityDepositReceiptNotes(
  admissionId: string,
  paymentMethod: string,
  residentNotes?: string,
) {
  return [
    `Payment method: ${paymentMethod.trim()}`,
    `${PURPOSE_PREFIX} ${SECURITY_DEPOSIT_PURPOSE}`,
    `${ADMISSION_PREFIX} ${admissionId}`,
    residentNotes?.trim() || "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function securityDepositAdmissionId(notes: unknown) {
  const value = String(notes ?? "");
  const purpose = value.match(/^Payment purpose:\s*(.+)$/im)?.[1]?.trim();
  if (purpose !== SECURITY_DEPOSIT_PURPOSE) return null;

  const admissionId = value.match(/^Admission ID:\s*([0-9a-f-]{36})$/im)?.[1];
  return admissionId?.toLowerCase() ?? null;
}

export function isSecurityDepositReceipt(notes: unknown) {
  return Boolean(securityDepositAdmissionId(notes));
}

export function receiptPaymentMethod(notes: unknown) {
  return String(notes ?? "").match(/^Payment method:\s*(.+)$/im)?.[1]?.trim() ?? "";
}

export function residentReceiptNotes(notes: unknown) {
  return String(notes ?? "")
    .split("\n")
    .filter((line) =>
      !/^(Payment method:|Payment purpose:|Admission ID:)/i.test(line.trim()),
    )
    .join(" ")
    .trim();
}

/** Labels come from actual allocated bill types, never the allocation count. */
export function allocatedPaymentLabel(allocations: Array<{ bill_id: string }>, bills: Array<Record<string, unknown>>) {
  return [...new Set(allocations.map(allocation => {
    const bill = bills.find(row => row.id === allocation.bill_id);
    return bill?.bill_type === "Other Charges" ? "Additional Charges" : String(bill?.bill_type || "");
  }).filter(Boolean))].join(" + ");
}
