/** Presentation only: preserve the receipt's historical verification state. */
export function receiptDisplayStatus<T extends string>(receipt: { status: T; payment_id?: string | null }, payments: ReadonlyArray<{ id?: unknown; payment_status?: unknown }>): T | "Cancelled" {
  return receipt.payment_id && payments.some(p => p.id === receipt.payment_id && p.payment_status === "Cancelled")
    ? "Cancelled" : receipt.status;
}
