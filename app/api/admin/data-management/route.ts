import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { verifyDataAdmin, type VerifiedDataAdmin } from "@/lib/adminDataManagement";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type DeleteCounts = Record<string, number>;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sanitizedDatabaseError(error: { code?: string; message?: string } | null) {
  return {
    code: String(error?.code ?? "UNKNOWN").slice(0, 32),
    message: String(error?.message ?? "Unknown database error")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{23,}/gi, "[uuid]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .slice(0, 500),
  };
}

function diagnostic(event: string, details: Record<string, unknown>) {
  console.info("[admin-data-management]", { event, ...details });
}

function json(body: object, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function relationValue(value: unknown, key: string) {
  const relation = Array.isArray(value) ? value[0] : value;
  if (!relation || typeof relation !== "object") return null;
  const field = (relation as Record<string, unknown>)[key];
  return field == null ? null : String(field);
}

function revalidateOperationalPages() {
  for (const path of [
    "/dashboard", "/residents", "/admissions", "/rooms", "/beds",
    "/billing", "/payments", "/payment-verification", "/contracts",
    "/inspection", "/maintenance", "/notices", "/reports",
    "/dashboard/notifications", "/dashboard/inventory",
  ]) revalidatePath(path);
}

async function recordFailure(
  admin: VerifiedDataAdmin,
  actionType: "FULL_RESET" | "RESIDENT_DELETE",
  errorMessage: string,
  resident?: { id: string; full_name: string },
) {
  await supabaseAdmin.from("admin_data_action_audits").insert({
    admin_user_id: admin.authUser.id,
    admin_staff_user_id: admin.staffId,
    admin_email: admin.email,
    action_type: actionType,
    deleted_resident_id: resident?.id ?? null,
    deleted_resident_name: resident?.full_name ?? null,
    deleted_record_counts: {},
    status: "FAILED",
    error_message: errorMessage.slice(0, 1000),
  });
}

export async function GET(request: NextRequest) {
  try {
    const verification = await verifyDataAdmin(request);
    if (!verification.admin) return json({ error: verification.error }, verification.status);

    const { data, error } = await supabaseAdmin
      .from("residents")
      .select("id, resident_code, full_name, email, phone, status, admissions(id, admission_number, room_id, bed_id, status, rooms(room_number), beds(bed_number)), bills(total_amount, paid_amount, balance_amount, bill_status)")
      .order("full_name", { ascending: true });

    if (error) return json({ error: "Resident data could not be loaded." }, 500);

    const residents = (data ?? []).map((resident) => {
      const admissions = Array.isArray(resident.admissions) ? resident.admissions : [];
      const currentAdmission = admissions.find((item) => !["checked out", "cancelled", "rejected"].includes(String(item.status ?? "").toLowerCase())) ?? admissions[0] ?? null;
      const bills = Array.isArray(resident.bills) ? resident.bills : [];
      const outstandingBalance = bills.reduce((sum, bill) => {
        const recorded = Number(bill.balance_amount);
        return sum + (Number.isFinite(recorded) ? Math.max(recorded, 0) : Math.max(Number(bill.total_amount || 0) - Number(bill.paid_amount || 0), 0));
      }, 0);

      return {
        id: resident.id,
        residentCode: resident.resident_code,
        fullName: resident.full_name,
        email: resident.email,
        phone: resident.phone,
        status: resident.status,
        admissionStatus: currentAdmission?.status ?? "No admission",
        room: relationValue(currentAdmission?.rooms, "room_number"),
        bed: relationValue(currentAdmission?.beds, "bed_number"),
        outstandingBalance,
      };
    });

    return json({ residents });
  } catch {
    return json({ error: "Resident data could not be loaded." }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const verification = await verifyDataAdmin(request);
    if (!verification.admin) {
      diagnostic("admin_verification", { success: false, status: verification.status });
      return json({ error: verification.error }, verification.status);
    }
    const { admin } = verification;
    diagnostic("admin_verification", {
      success: true,
      authUserIdIsUuid: UUID_PATTERN.test(admin.authUser.id),
      staffIdIsUuid: UUID_PATTERN.test(admin.staffId),
    });
    if (!UUID_PATTERN.test(admin.authUser.id)) {
      return json({ error: "The administrator account identifier is invalid." }, 500);
    }
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      confirmation?: unknown;
      acknowledged?: unknown;
      residentId?: unknown;
      residentName?: unknown;
    } | null;

    if (body?.action === "FULL_RESET") {
      if (body.acknowledged !== true || body.confirmation !== "RESET HOSTEL DATA") {
        return json({ error: "The reset confirmation is incomplete." }, 400);
      }
      diagnostic("rpc_call", { function: "admin_full_hostel_reset", confirmationValid: true });
      const { data, error } = await supabaseAdmin.rpc("admin_full_hostel_reset", {
        p_admin_user_id: admin.authUser.id,
        p_admin_email: admin.email,
        p_confirmation: body.confirmation,
      });
      if (error) {
        const sanitized = sanitizedDatabaseError(error);
        console.error("[admin-data-management]", {
          event: "rpc_failure",
          function: "admin_full_hostel_reset",
          ...sanitized,
          transactionRollbackReason: sanitized.message,
        });
        await recordFailure(admin, "FULL_RESET", error.message);
        return json({ error: sanitized.message || "The hostel reset could not be completed. No partial reset was committed." }, 500);
      }
      diagnostic("rpc_success", { function: "admin_full_hostel_reset" });
      revalidateOperationalPages();
      return json({ message: "System reset completed successfully", counts: (data ?? {}) as DeleteCounts });
    }

    if (body?.action === "RESIDENT_DELETE") {
      const residentId = typeof body.residentId === "string" ? body.residentId.trim() : "";
      const residentName = typeof body.residentName === "string" ? body.residentName.trim() : "";
      if (!residentId || !residentName || body.acknowledged !== true) {
        return json({ error: "The resident deletion confirmation is incomplete." }, 400);
      }

      const { data: resident } = await supabaseAdmin
        .from("residents")
        .select("id, full_name")
        .eq("id", residentId)
        .maybeSingle();
      if (!resident) return json({ error: "The selected resident no longer exists." }, 404);
      if (residentName.toLocaleLowerCase() !== String(resident.full_name).trim().toLocaleLowerCase()) {
        return json({ error: "The resident name confirmation does not match." }, 400);
      }

      diagnostic("rpc_call", { function: "admin_delete_resident_data", confirmationValid: true });
      const { data, error } = await supabaseAdmin.rpc("admin_delete_resident_data", {
        p_admin_user_id: admin.authUser.id,
        p_admin_email: admin.email,
        p_resident_id: residentId,
        p_resident_name_confirmation: residentName,
      });
      if (error) {
        const sanitized = sanitizedDatabaseError(error);
        console.error("[admin-data-management]", {
          event: "rpc_failure",
          function: "admin_delete_resident_data",
          ...sanitized,
          transactionRollbackReason: sanitized.message,
        });
        await recordFailure(admin, "RESIDENT_DELETE", error.message, resident);
        return json({ error: sanitized.message || "The resident could not be removed. No partial deletion was committed." }, 500);
      }
      diagnostic("rpc_success", { function: "admin_delete_resident_data" });
      revalidateOperationalPages();
      return json({ message: "Resident removed successfully", counts: (data ?? {}) as DeleteCounts });
    }

    return json({ error: "A valid data-management action is required." }, 400);
  } catch {
    return json({ error: "The data-management request could not be completed." }, 500);
  }
}
