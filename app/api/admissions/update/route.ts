import { NextRequest } from "next/server";
import { apiError, apiJson, requireStaff } from "@/lib/adminApiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function POST(request: NextRequest) {
  const auth = await requireStaff(request, [
    "super admin",
    "admin",
    "manager",
    "staff",
    "reception",
  ]);
  if (auth.response) return auth.response;

  try {
    const body = (await request.json().catch(() => null)) as {
      id?: unknown;
      admission_date?: unknown;
      expected_leaving_date?: unknown;
      monthly_rent?: unknown;
      security_deposit?: unknown;
      deposit_status?: unknown;
      notice_period_days?: unknown;
      notes?: unknown;
    } | null;

    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id) return apiError("Admission ID is required.", 400);

    const newDeposit = Number(body?.security_deposit ?? 0);
    if (!Number.isFinite(newDeposit) || newDeposit < 0) {
      return apiError("Security deposit must be a valid non-negative amount.", 400);
    }

    const monthlyRent = Number(body?.monthly_rent ?? 0);
    if (!Number.isFinite(monthlyRent) || monthlyRent < 0) {
      return apiError("Monthly rent must be a valid non-negative amount.", 400);
    }

    const noticePeriod = Number(body?.notice_period_days ?? 30);
    const validDepositStatuses = ["Pending", "Held", "Released", "Deducted"];
    const depositStatus =
      typeof body?.deposit_status === "string" &&
      validDepositStatuses.includes(body.deposit_status)
        ? body.deposit_status
        : undefined;

    // Fetch existing admission
    const { data: previousAdmission, error: fetchErr } = await supabaseAdmin
      .from("admissions")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr || !previousAdmission) {
      return apiError("Admission record could not be found.", 404);
    }

    const previousDeposit = Number(previousAdmission.security_deposit ?? 0);
    const isDepositChanged = newDeposit !== previousDeposit;
    const isNonPending = previousAdmission.status !== "Pending";

    const basePayload = {
      admission_date: typeof body?.admission_date === "string" ? body.admission_date : previousAdmission.admission_date,
      expected_leaving_date: typeof body?.expected_leaving_date === "string" && body.expected_leaving_date.trim() ? body.expected_leaving_date.trim() : null,
      monthly_rent: monthlyRent,
      notice_period_days: Number.isFinite(noticePeriod) && noticePeriod >= 0 ? noticePeriod : 30,
      notes: typeof body?.notes === "string" && body.notes.trim() ? body.notes.trim() : null,
      ...(depositStatus ? { deposit_status: depositStatus } : {}),
      updated_at: new Date().toISOString(),
    };

    if (isDepositChanged && isNonPending) {
      // Step 1: Temporarily set status to Pending to allow trigger-based deposit & DEP- bill reconciliation
      const { error: pendErr } = await supabaseAdmin
        .from("admissions")
        .update({ status: "Pending" })
        .eq("id", id);

      if (pendErr) {
        return apiError("Unable to prepare admission for deposit reconciliation. " + pendErr.message, 400);
      }

      // Step 2: Update security deposit & related fields (triggers bills reconciliation)
      const { data: updated, error: updateErr } = await supabaseAdmin
        .from("admissions")
        .update({
          ...basePayload,
          security_deposit: newDeposit,
        })
        .eq("id", id)
        .select()
        .single();

      // Step 3: Always restore original admission status
      await supabaseAdmin
        .from("admissions")
        .update({ status: previousAdmission.status })
        .eq("id", id);

      if (updateErr) {
        return apiError(updateErr.message || "Unable to update security deposit.", 400);
      }

      return apiJson({
        success: true,
        admission: updated,
        message: "Admission and security deposit updated successfully.",
      });
    }

    // Standard update (admission is Pending or deposit was not changed)
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("admissions")
      .update({
        ...basePayload,
        security_deposit: newDeposit,
      })
      .eq("id", id)
      .select()
      .single();

    if (updateErr) {
      return apiError(updateErr.message || "Unable to update admission.", 400);
    }

    return apiJson({
      success: true,
      admission: updated,
      message: "Admission updated successfully.",
    });
  } catch (err) {
    console.error("[admissions:update] Unexpected error:", err);
    return apiError("An unexpected error occurred while updating the admission.", 500);
  }
}
