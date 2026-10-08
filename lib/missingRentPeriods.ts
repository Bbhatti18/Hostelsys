import { rentDueDate } from "./billApproval";

export function currentRentMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit" }).formatToParts(now);
  return `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`;
}

export function isCurrentRentAdmission(admission: Record<string, unknown>, admissions: Record<string, unknown>[]) {
  const key = (a: Record<string, unknown>) => [a.admission_date, a.created_at, a.id].map(String).join("|");
  return ["Pending", "Active"].includes(String(admission.status)) && !admissions.some(a =>
    a.resident_id === admission.resident_id && key(a) > key(admission));
}

export function missingRentMonths(admission: Record<string, unknown>, bills: Record<string, unknown>[], current = currentRentMonth()) {
  const start = String(admission.admission_date ?? "").slice(0, 7);
  if (!["Pending", "Active"].includes(String(admission.status))) return [];
  try { rentDueDate(String(admission.admission_date), current); } catch { return []; }
  const existing = new Set(bills.filter(b => b.admission_id === admission.id && b.bill_type === "Rent").map(b => String(b.billing_month)));
  const [year, month] = start.split("-").map(Number), [lastYear, lastMonth] = current.split("-").map(Number);
  const missing: string[] = [];
  for (let index = year * 12 + month - 1; index <= lastYear * 12 + lastMonth - 1; index++) {
    const period = `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`;
    if (!existing.has(period)) missing.push(period);
  }
  return missing;
}
