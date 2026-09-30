export const LATE_FEE_DAILY_RATE = 300;
export const LATE_FEE_GRACE_LAST_DAY = 5;

function dateOnly(value: string | Date) {
  if (value instanceof Date) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Karachi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  }
  return String(value).slice(0, 10);
}

function parseDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("Invalid date.");
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function utcDayNumber(year: number, month: number, day: number) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

/**
 * Hostel late-fee rule:
 * Preview only; the database validates eligibility, payments and waivers.
 * Calendar days 1-5 defer the current month's charge; day six includes them.
 * Only a next actual rent bill establishes an exclusive cycle boundary.
 */
export function calculateLateFee(
  dueDate: string | Date,
  asOf: string | Date = new Date(),
  nextDueDate?: string | Date,
) {
  const bill = parseDateOnly(dateOnly(dueDate));
  const current = parseDateOnly(dateOnly(asOf));
  const dueNo = utcDayNumber(bill.year, bill.month, bill.day);
  const startNo = Math.max(dueNo + 1, utcDayNumber(current.year, current.month, 1));
  const currentNo = utcDayNumber(current.year, current.month, current.day);
  let endNo = currentNo + 1;
  if (nextDueDate) {
    const next = parseDateOnly(dateOnly(nextDueDate));
    const nextNo = utcDayNumber(next.year, next.month, next.day);
    if (nextNo > dueNo) endNo = Math.min(endNo, nextNo);
  }
  const days = Math.max(0, Math.min(currentNo, endNo - 1) - startNo + 1);
  return current.day <= LATE_FEE_GRACE_LAST_DAY ? 0 : days * LATE_FEE_DAILY_RATE;
}

export function lateFeePayable(
  calculatedAmount: number,
  waivedAmount = 0,
  frozenAmount: number | null = null,
  paidAmount = 0,
) {
  const basis = frozenAmount ?? calculatedAmount;
  return Math.max(
    Math.round((basis - Math.max(waivedAmount, 0) - Math.max(paidAmount, 0)) * 100) / 100,
    0,
  );
}
