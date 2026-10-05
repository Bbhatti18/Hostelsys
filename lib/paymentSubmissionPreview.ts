import { roundMoney } from "./financialMath";

/** Pending reserves capacity only; this preview never computes accounting credit. */
export function paymentSubmissionPreview(financialOutstanding: number, pending: number, entered: number) {
  const financialBalance = Math.max(roundMoney(financialOutstanding), 0);
  const awaitingReview = Math.max(roundMoney(pending), 0);
  const available = Math.max(roundMoney(financialBalance - awaitingReview), 0);
  const submitting = Number.isFinite(entered) ? Math.max(roundMoney(entered), 0) : 0;
  const projectedAvailableRemainder = Math.max(roundMoney(available - submitting), 0);
  return { financialBalance, awaitingReview, available, projectedAvailableRemainder,
    exceedsAvailable: submitting > available,
    requiresCommitment: submitting > 0 && projectedAvailableRemainder > 0 };
}
