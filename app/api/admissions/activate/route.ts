import { NextRequest } from "next/server";
import { apiError, apiJson, requireStaff } from "@/lib/adminApiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAdmissionDeposit, getAdmissionRent, isAdmissionActivationReady } from "@/lib/contractWorkflow";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";
import { readDashboardRows } from "@/lib/dashboardRead";

export async function POST(request: NextRequest) {
  const auth = await requireStaff(request, ["super admin", "admin", "manager", "staff"]);
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => null);
  if (typeof body?.admissionId !== "string" || !body.admissionId.trim()) return apiError("Admission ID is required.", 400);
  const admissionId = body.admissionId;
  try {
    const admissionResult = await supabaseAdmin.from("admissions").select("*").eq("id", admissionId).maybeSingle();
    if (admissionResult.error || !admissionResult.data) return apiError("Admission could not be loaded.", 404);
    const admission = admissionResult.data;
    const [resident, room, bed, contract, admissions, bills, payments] = await Promise.all([
      supabaseAdmin.from("residents").select("id, status").eq("id", admission.resident_id).maybeSingle(),
      supabaseAdmin.from("rooms").select("id, status").eq("id", admission.room_id).maybeSingle(),
      supabaseAdmin.from("beds").select("id, room_id, status").eq("id", admission.bed_id).maybeSingle(),
      supabaseAdmin.from("contracts").select("*").eq("admission_id", admissionId).eq("resident_id", admission.resident_id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      readDashboardRows(supabaseAdmin.from("admissions").select("id, resident_id, bed_id, status, admission_date, created_at").order("id")),
      readDashboardRows(supabaseAdmin.from("bills").select("*").eq("admission_id", admissionId).order("id")),
      readDashboardRows(supabaseAdmin.from("payments").select("id, resident_id, bill_id, amount, payment_status, payment_allocations(bill_id, amount)").eq("resident_id", admission.resident_id).order("id")),
    ]);
    if ([resident, room, bed, contract, admissions, bills, payments].some(result => result.error)) return apiError("Unable to verify activation prerequisites.", 503);
    const context = { admission, resident: resident.data, room: room.data, bed: bed.data, contract: contract.data };
    const deposit = getAdmissionDeposit(admission, bills.data ?? [], payments.data ?? []);
    if (getAdmissionRent(admission, bills.data ?? [], payments.data ?? []).state !== "verified") return apiError("Initial admission Rent must be fully verified before activation.", 409);
    if (!isAdmissionActivationReady({ ...context, depositState: deposit.state, admissions: admissions.data ?? [], bills: bills.data ?? [], payments: payments.data ?? [] }) || !context.contract || !context.resident) return apiError("This admission does not meet the activation prerequisites.", 409);
    const previousContractStatus = context.contract.status;
    let contractActivation = supabaseAdmin
      .from("contracts")
      .update({
        status: "Active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", context.contract.id)
      .eq("admission_id", admissionId)
      .eq("resident_signature_url", context.contract.resident_signature_url)
      .eq("signed_at", context.contract.signed_at)
      .eq("signed_by_resident", true)
      .eq("contract_content", context.contract.contract_content)
      .eq("resident_signature_status", "Approved");

    contractActivation = previousContractStatus
      ? contractActivation.eq("status", previousContractStatus)
      : contractActivation.is("status", null);

    const { data: activatedContract, error: contractActivateError } =
      await contractActivation
      .select("id")
      .maybeSingle();

    if (contractActivateError || !activatedContract) {
      throw new Error(
        contractActivateError
          ? getSupabaseErrorMessage(
              contractActivateError,
              "Unable to activate the signed contract. The admission remains Pending.",
            )
          : "The signed contract could not be activated. The admission remains Pending.",
      );
    }

    const { data: activated, error: activateError } = await supabaseAdmin
      .from("admissions")
      .update({ status: "Active", updated_at: new Date().toISOString() })
      .eq("id", admissionId)
      .eq("resident_id", context.admission.resident_id)
      .eq("room_id", context.admission.room_id)
      .eq("bed_id", context.admission.bed_id)
      .eq("deposit_status", context.admission.deposit_status)
      .eq("security_deposit", context.admission.security_deposit)
      .eq("admission_date", context.admission.admission_date)
      .eq("status", "Pending")
      .select("id")
      .maybeSingle();

    if (activateError || !activated) {
      const { data: rolledBackContract, error: rollbackError } = await supabaseAdmin
        .from("contracts")
        .update({
          status: previousContractStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", context.contract.id)
        .eq("status", "Active")
        .select("id")
        .maybeSingle();

      throw new Error(
        rollbackError || !rolledBackContract
          ? "Admission activation failed and the contract could not be returned to its previous status. The resident signature and terms were preserved; contact an administrator."
          : activateError
          ? getSupabaseErrorMessage(
              activateError,
              "Unable to activate this admission. The contract was returned to its previous status.",
            )
          : "This admission is no longer Pending. The contract was returned to its previous status.",
      );
    }

    let residentActivation = supabaseAdmin
      .from("residents")
      .update({
        status: "Active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", context.admission.resident_id);
    residentActivation = context.resident.status
      ? residentActivation.eq("status", context.resident.status)
      : residentActivation.is("status", null);
    const { data: activatedResident, error: residentActivateError } =
      await residentActivation.select("id").maybeSingle();
    if (residentActivateError || !activatedResident) {
      const [{ data: rolledBackAdmission }, { data: rolledBackContract }] =
        await Promise.all([
          supabaseAdmin
            .from("admissions")
            .update({ status: "Pending", updated_at: new Date().toISOString() })
            .eq("id", admissionId)
            .eq("status", "Active")
            .select("id")
            .maybeSingle(),
          supabaseAdmin
            .from("contracts")
            .update({
              status: previousContractStatus,
              updated_at: new Date().toISOString(),
            })
            .eq("id", context.contract.id)
            .eq("status", "Active")
            .select("id")
            .maybeSingle(),
        ]);
      throw new Error(
        rolledBackAdmission && rolledBackContract
          ? "The resident operational status could not be activated, so the admission and contract were returned to Pending."
          : "The resident operational status could not be activated and the lifecycle rollback was incomplete. Please contact an administrator.",
      );
    }

    return apiJson({ message: deposit.state === "not_required"
      ? "Rent and contract verified; no deposit required. Admission activated successfully."
      : "Rent, deposit and contract verified. Admission activated successfully." });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "Unable to activate this admission.", 409);
  }
}
