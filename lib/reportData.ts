import { paymentBillAmounts } from "./paymentAllocations";
/** Report projections and display-only joins. No database writes or finance calculations. */
export type ReportRow = { id?: string | number; [key: string]: unknown };
export type ReportSource = "residents" | "rooms" | "beds" | "admissions" | "bills" | "payments" | "maintenance_requests" | "inventory";

export const REPORT_COLUMNS = {
  residents: "id, resident_code, full_name, phone, cnic, email, status, created_at",
  rooms: "id, room_number, floor_number, total_beds, status, created_at",
  beds: "id, room_id, bed_number, status, created_at",
  admissions: "id, resident_id, room_id, bed_id, admission_number, admission_date, expected_leaving_date, security_deposit, monthly_rent, status, created_at",
  bills: "id, resident_id, admission_id, bill_number, bill_type, billing_month, rent_amount, electricity_amount, ac_amount, other_amount, discount_amount, total_amount, paid_amount, balance_amount, due_date, bill_status, created_at",
  payments: "id, resident_id, bill_id, payment_number, payment_date, amount, payment_status, payment_method, reference_number, verified_at, created_at, payment_allocations(payment_id,bill_id,amount)",
  contracts: "id, resident_id, admission_id, contract_number, start_date, end_date, monthly_rent, status, resident_signature_status, owner_signature_status, signed_by_resident, created_at",
  room_inspections: "id, resident_id, room_id, bed_id, inspection_number, inspection_date, inspection_type, overall_status, damage_found, damage_description, estimated_damage_cost, actual_damage_cost, status",
  inspections: "id, resident_id, room_id, inspection_date, damage_notes",
  maintenance_requests: "id, resident_id, room_id, bed_id, request_number, title, description, category, priority, status, assigned_to, estimated_cost, actual_cost, complaint_date, completion_date, completed_at, created_at",
  inventory_categories: "id, name",
  inventory: "id, item_name, category_id, quantity, purchase_date, created_at",
} as const;

const key = (value: unknown) => value == null ? "" : String(value);
export function reportDate(row: ReportRow, source: ReportSource) {
  if (source === "bills") {
    const month = key(row.billing_month);
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month + "-01" : key(row.created_at).slice(0, 10);
  }
  const eventFields: Partial<Record<ReportSource, string>> = { admissions: "admission_date", payments: "payment_date", maintenance_requests: "complaint_date", inventory: "purchase_date" };
  const eventField = eventFields[source];
  return key((eventField ? row[eventField] : null) || row.created_at).slice(0, 10);
}

export function reportLookups(data: { residents: ReportRow[]; rooms: ReportRow[]; beds: ReportRow[]; admissions: ReportRow[]; bills: ReportRow[] }) {
  const index = (rows: ReportRow[]) => new Map(rows.map(row => [key(row.id), row]));
  return { residents: index(data.residents), rooms: index(data.rooms), beds: index(data.beds), admissions: index(data.admissions), bills: index(data.bills) };
}

export function joinReportRows(rows: ReportRow[], source: ReportSource, lookup: ReturnType<typeof reportLookups>): ReportRow[] {
  return rows.map(row => {
    // Transaction location belongs to its own admission, never the resident's latest admission.
    const allocationBill = source === "payments" && Array.isArray(row.payment_allocations)
      ? lookup.bills.get(key(row.payment_allocations[0]?.bill_id))
      : undefined;
    const bill = source === "payments" ? lookup.bills.get(key(row.bill_id)) || allocationBill : source === "bills" ? row : undefined;
    const admission = bill ? lookup.admissions.get(key(bill.admission_id)) : undefined;
    const roomId = source === "payments" || source === "bills" ? admission?.room_id : row.room_id;
    const bedId = source === "payments" || source === "bills" ? admission?.bed_id : row.bed_id;
    return {
      ...row,
      report_date: reportDate(row, source),
      resident_name: lookup.residents.get(key(row.resident_id))?.full_name ?? null,
      room_number: source === "rooms" ? row.room_number : lookup.rooms.get(key(roomId))?.room_number ?? null,
      bed_number: source === "beds" ? row.bed_number : lookup.beds.get(key(bedId))?.bed_number ?? null,
    };
  });
}

/** Per-payment verified collection split; the parent total is counted only once. */
export function paymentCollectionBreakdown(payment: ReportRow, bills: ReportRow[]) {
  const allocations = (Array.isArray(payment.payment_allocations) ? payment.payment_allocations : []) as Array<{ bill_id: string; amount: number }>;
  const split = { rent: 0, deposit: 0, other: 0 };
  for (const allocation of paymentBillAmounts({ bill_id: payment.bill_id as string | null, payment_status: String(payment.payment_status), amount: Number(payment.amount) }, allocations)) {
    const type = bills.find(bill => bill.id === allocation.bill_id)?.bill_type;
    const key = type === "Rent" ? "rent" : type === "Security Deposit" ? "deposit" : "other";
    split[key] += Number(allocation.amount);
  }
  return split;
}
