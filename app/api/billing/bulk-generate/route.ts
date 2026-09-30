import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { notifyResidentEvent } from "@/lib/notifications/server";
import {
  BILLING_STAFF_ROLES,
  apiError,
  apiJson,
  requireStaff,
} from "@/lib/adminApiAuth";
import {
  billingMonthOf,
  rentDueDate,
  isBillingMonth,
} from "@/lib/billApproval";
import {
  getMeterReadingConfig,
  isResidentElectricityEnabled,
} from "@/lib/meterReading";

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

type SkippedBill = {
  admissionId: string;
  residentName: string;
  reason: string;
};

const PENDING_APPROVAL = "Pending Approval";
const MAX_BULK_BILLS = 500;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function amount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? roundMoney(parsed) : 0;
}

function billNumber(billingMonth: string, index: number) {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `BILL-${billingMonth.replace("-", "")}-${String(index + 1).padStart(3, "0")}${suffix}`;
}

export async function POST(request: NextRequest) {
  try {
    const { staff, response } = await requireStaff(request, BILLING_STAFF_ROLES);
    if (!staff) return response;

    const body = (await request.json().catch(() => null)) as
      | { billingMonth?: unknown }
      | null;
    const billingMonth =
      body?.billingMonth === undefined || body?.billingMonth === null || body?.billingMonth === ""
        ? billingMonthOf()
        : text(body.billingMonth).slice(0, 7);

    if (!isBillingMonth(billingMonth)) {
      return apiError("A valid billing month (YYYY-MM) is required.", 400);
    }

    const [admissionsResult, billsResult] = await Promise.all([
      supabaseAdmin
        .from("admissions")
        .select("id, resident_id, room_id, monthly_rent, admission_date, status")
        .eq("status", "Active")
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("bills")
        .select("id, admission_id, bill_status")
        .eq("billing_month", billingMonth),
    ]);

    if (admissionsResult.error) {
      return apiError("Active admissions could not be loaded.", 500);
    }
    if (billsResult.error) {
      return apiError("Existing bills for this month could not be checked.", 500);
    }

    const admissions = admissionsResult.data ?? [];
    if (admissions.length === 0) {
      return apiJson({
        billingMonth,
        created: [],
        createdCount: 0,
        skipped: [],
        activeAdmissionCount: 0,
      });
    }
    if (admissions.length > MAX_BULK_BILLS) {
      return apiError(
        `Bulk generation is limited to ${MAX_BULK_BILLS} admissions per run.`,
        400,
      );
    }

    const billedAdmissionIds = new Set(
      (billsResult.data ?? [])
        .filter((bill) => text(bill.bill_status).toLowerCase() !== "cancelled")
        .map((bill) => text(bill.admission_id)),
    );

    const residentIds = [...new Set(admissions.map((row) => text(row.resident_id)))];
    const admissionIds = admissions.map((row) => text(row.id));

    const [residentsResult, contractsResult, meterConfig, acReadingsResult] = await Promise.all([
      supabaseAdmin
        .from("residents")
        .select("id, full_name, status")
        .in("id", residentIds),
      supabaseAdmin
        .from("contracts")
        .select("id, admission_id, monthly_rent, status")
        .in("admission_id", admissionIds),
      getMeterReadingConfig(supabaseAdmin),
      supabaseAdmin
        .from("ac_bills")
        .select("id, resident_id, admission_id, billing_month, total_amount, bill_id")
        .eq("billing_month", billingMonth),
    ]);

    if (residentsResult.error || contractsResult.error) {
      return apiError("Resident and contract details could not be loaded.", 500);
    }

    const residentById = new Map(
      (residentsResult.data ?? []).map((row) => [text(row.id), row]),
    );
    const contractRentByAdmission = new Map<string, number>();
    for (const contract of contractsResult.data ?? []) {
      const status = text(contract.status).toLowerCase();
      if (status === "cancelled" || status === "terminated") continue;
      const rent = amount(contract.monthly_rent);
      if (rent > 0) contractRentByAdmission.set(text(contract.admission_id), rent);
    }

    const generatedAt = new Date();
    const timestamp = generatedAt.toISOString();
    const skipped: SkippedBill[] = [];
    const rows: (Record<string, unknown> & { _reading_id?: string | null })[] = [];

    admissions.forEach((admission, index) => {
      const admissionId = text(admission.id);
      const residentId = text(admission.resident_id);
      const resident = residentById.get(residentId);
      const residentName = text(resident?.full_name) || "Unknown resident";

      if (!resident) {
        skipped.push({ admissionId, residentName, reason: "Resident profile was not found." });
        return;
      }
      if (text(resident.status).toLowerCase() === "archived") {
        skipped.push({ admissionId, residentName, reason: "Resident is archived." });
        return;
      }
      if (billedAdmissionIds.has(admissionId)) {
        skipped.push({
          admissionId,
          residentName,
          reason: "A bill already exists for this month.",
        });
        return;
      }

      let dueDate: string;
      try {
        dueDate = rentDueDate(text(admission.admission_date), billingMonth);
      } catch {
        skipped.push({ admissionId, residentName, reason: "Invalid admission date or billing month before admission." });
        return;
      }
      const rent =
        amount(admission.monthly_rent) || contractRentByAdmission.get(admissionId) || 0;
      if (rent <= 0) {
        skipped.push({
          admissionId,
          residentName,
          reason: "No monthly rent is set on the admission or contract.",
        });
        return;
      }

      const isElectricityEnabled = isResidentElectricityEnabled(meterConfig, residentId);
      let meterCharge = 0;
      let matchedReadingId: string | null = null;

      if (isElectricityEnabled) {
        const reading = (acReadingsResult.data ?? []).find(
          (r) =>
            (r.admission_id === admissionId || r.resident_id === residentId) &&
            !r.bill_id
        );
        if (reading) {
          meterCharge = amount(reading.total_amount);
          matchedReadingId = reading.id;
        }
      }

      const totalBillAmount = roundMoney(rent + meterCharge);

      rows.push({
        bill_number: billNumber(billingMonth, index),
        resident_id: residentId,
        admission_id: admissionId,
        billing_month: billingMonth,
        rent_amount: rent,
        electricity_amount: 0,
        ac_amount: meterCharge,
        other_amount: 0,
        discount_amount: 0,
        total_amount: totalBillAmount,
        paid_amount: 0,
        balance_amount: totalBillAmount,
        due_date: dueDate,
        bill_status: PENDING_APPROVAL,
        notes: `Bulk generated on ${timestamp.slice(0, 10)} by ${staff.email}. Admission-cycle due date ${dueDate}.${meterCharge > 0 ? ` Includes electricity meter charges: Rs ${meterCharge.toLocaleString()}.` : ""}`,
        created_at: timestamp,
        updated_at: timestamp,
        _reading_id: matchedReadingId,
      });
    });

    if (rows.length === 0) {
      return apiJson({
        billingMonth,
        created: [],
        createdCount: 0,
        skipped,
        activeAdmissionCount: admissions.length,
      });
    }

    const billInsertPayloads = rows.map(({ _reading_id, ...billData }) => billData);
    const { data: created, error: insertError } = await supabaseAdmin
      .from("bills")
      .insert(billInsertPayloads)
      .select("id, bill_number, resident_id, admission_id, billing_month, total_amount, due_date, bill_status");

    if (insertError) {
      console.error("[billing] Bulk bill generation failed.", {
        billingMonth,
        attempted: billInsertPayloads.length,
        message: insertError.message,
      });
      return apiError(
        "The bills could not be generated. No bills were created; please try again.",
        500,
      );
    }

    // Link created bills to their meter readings:
    for (const createdBill of created ?? []) {
      const originalRow = rows.find((r) => r.admission_id === createdBill.admission_id);
      if (originalRow?._reading_id) {
        await supabaseAdmin
          .from("ac_bills")
          .update({ bill_id: createdBill.id })
          .eq("id", originalRow._reading_id);
      }
    }

    const notificationResults = await Promise.allSettled(
      (created ?? []).map((bill) =>
        notifyResidentEvent("bill_generated", bill.id, { channels: ["email"] }),
      ),
    );

    const notificationFailures = notificationResults.filter(
      (result) =>
        result.status === "rejected" ||
        (result.status === "fulfilled" && !result.value.delivered),
    ).length;

    if (notificationFailures > 0) {
      console.warn("[billing] Some bill notifications were not delivered.", {
        billingMonth,
        failed: notificationFailures,
        attempted: created?.length ?? 0,
      });
    }
    console.info("[billing] Bulk bills generated.", {
      billingMonth,
      created: created?.length ?? 0,
      skipped: skipped.length,
      by: staff.email,
    });

    return apiJson({
      billingMonth,
      created: created ?? [],
      createdCount: created?.length ?? 0,
      skipped,
      activeAdmissionCount: admissions.length,
    });
  } catch (error) {
    console.error("[billing] Unexpected bulk generation failure.", error);
    return apiError("The bills could not be generated. Please try again.", 500);
  }
}
