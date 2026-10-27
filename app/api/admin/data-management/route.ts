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
      .neq("status", "Archived")
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
        .select("id, full_name, status")
        .eq("id", residentId)
        .maybeSingle();
      if (!resident) return json({ error: "The selected resident no longer exists." }, 404);
      if (residentName.toLocaleLowerCase() !== String(resident.full_name).trim().toLocaleLowerCase()) {
        return json({ error: "The resident name confirmation does not match." }, 400);
      }

      diagnostic("resident_archive_start", { residentId, residentName });

      // 1. Fetch resident admissions to free bed and update rooms
      const { data: admissions } = await supabaseAdmin
        .from("admissions")
        .select("id, bed_id, room_id, status")
        .eq("resident_id", residentId);

      const admissionIds = (admissions ?? []).map((a) => a.id);
      const bedIds = Array.from(new Set((admissions ?? []).map((a) => a.bed_id).filter(Boolean)));
      const roomIds = Array.from(new Set((admissions ?? []).map((a) => a.room_id).filter(Boolean)));

      // 2. Archive all admissions for this resident
      if (admissionIds.length > 0) {
        await supabaseAdmin
          .from("admissions")
          .update({
            status: "Archived",
            actual_leaving_date: new Date().toISOString().slice(0, 10),
            updated_at: new Date().toISOString(),
          })
          .eq("resident_id", residentId);
      }

      // 3. Vacate beds previously assigned to this resident if no other pending/active admission exists
      for (const bedId of bedIds) {
        const { data: otherAdmissions } = await supabaseAdmin
          .from("admissions")
          .select("id")
          .eq("bed_id", bedId)
          .in("status", ["Active", "Pending"])
          .limit(1);

        if (!otherAdmissions || otherAdmissions.length === 0) {
          await supabaseAdmin
            .from("beds")
            .update({ status: "Vacant", updated_at: new Date().toISOString() })
            .eq("id", bedId)
            .neq("status", "Inactive");
        }
      }

      // 4. Update room occupied bed counts
      for (const roomId of roomIds) {
        const { count } = await supabaseAdmin
          .from("beds")
          .select("id", { count: "exact", head: true })
          .eq("room_id", roomId)
          .ilike("status", "occupied");

        await supabaseAdmin
          .from("rooms")
          .update({ occupied_beds: count ?? 0, updated_at: new Date().toISOString() })
          .eq("id", roomId);
      }

      // 5. Terminate active/pending contracts
      await supabaseAdmin
        .from("contracts")
        .update({ status: "Terminated", updated_at: new Date().toISOString() })
        .eq("resident_id", residentId)
        .neq("status", "Terminated");

      // 6. Delete portal login links so resident can no longer sign in
      await supabaseAdmin
        .from("resident_portal_links")
        .delete()
        .eq("resident_id", residentId);

      // 7. Cancel uncollected draft/pending bills
      await supabaseAdmin
        .from("bills")
        .update({ bill_status: "Cancelled", updated_at: new Date().toISOString() })
        .eq("resident_id", residentId)
        .in("bill_status", ["Draft", "Pending Approval", "Pending"]);

      // 8. Delete inventory assignments if any
      await supabaseAdmin
        .from("inventory_assignments")
        .delete()
        .eq("resident_id", residentId);

      // 9. Update resident status to 'Archived' (soft delete)
      const { error: archiveError } = await supabaseAdmin
        .from("residents")
        .update({
          status: "Archived",
          updated_at: new Date().toISOString(),
        })
        .eq("id", residentId);

      if (archiveError) {
        const sanitized = sanitizedDatabaseError(archiveError);
        console.error("[admin-data-management]", {
          event: "archive_failure",
          ...sanitized,
        });
        await recordFailure(admin, "RESIDENT_DELETE", archiveError.message, resident);
        return json({ error: sanitized.message || "The resident could not be removed." }, 500);
      }

      // 10. Write audit trail
      await supabaseAdmin.from("admin_data_action_audits").insert({
        admin_user_id: admin.authUser.id,
        admin_staff_user_id: admin.staffId,
        admin_email: admin.email,
        action_type: "RESIDENT_DELETE",
        deleted_resident_id: resident.id,
        deleted_resident_name: resident.full_name,
        deleted_record_counts: { residents: 1, admissions: (admissions ?? []).length },
        status: "SUCCESS",
      });

      diagnostic("resident_archive_success", { residentId });
      revalidateOperationalPages();

      return json({
        message: `${resident.full_name} has been removed from the system successfully.`,
        counts: { residents: 1, admissions: (admissions ?? []).length } as DeleteCounts,
      });
    }

    return json({ error: "A valid data-management action is required." }, 400);
  } catch {
    return json({ error: "The data-management request could not be completed." }, 500);
  }
}
