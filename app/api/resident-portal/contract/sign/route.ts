import { normalizeIdentityEmail } from "@/lib/identity";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { notifyResidentEvent } from "@/lib/notifications/server";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";

function bearerToken(request: NextRequest) {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
}

function jsonError(error: string, status: number) {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: NextRequest) {
  try {
    const token = bearerToken(request);
    if (!token) {
      return jsonError("Please sign in to sign the contract.", 401);
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return jsonError("Resident portal server configuration is incomplete.", 500);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    const user = authData.user;
    const email = user?.email?.trim().toLowerCase() ?? "";

    if (authError || !user || !email) {
      return jsonError("Please sign in to sign the contract.", 401);
    }

    const metadataResidentId =
      typeof user.user_metadata?.resident_id === "string"
        ? user.user_metadata.resident_id.trim()
        : "";

    let residentQuery = supabaseAdmin
      .from("residents")
      .select("id, email, full_name, status")
      .eq("email", normalizeIdentityEmail(email));

    if (metadataResidentId) {
      residentQuery = residentQuery.eq("id", metadataResidentId);
    }

    const { data: resident, error: residentError } = await residentQuery.maybeSingle();

    if (residentError) {
      return jsonError("Your resident account could not be verified.", 500);
    }
    if (!resident) {
      return jsonError("No resident profile is linked to this account.", 403);
    }

    const body = await request.json().catch(() => null);
    const contractId = typeof body?.contractId === "string" ? body.contractId.trim() : "";
    const signatureUrl = typeof body?.signatureUrl === "string" ? body.signatureUrl.trim() : "";

    if (!contractId) {
      return jsonError("Contract ID is required.", 400);
    }
    if (!signatureUrl) {
      return jsonError("Resident signature URL is required.", 400);
    }

    const { data: contract, error: contractError } = await supabaseAdmin
      .from("contracts")
      .select(
        "id, resident_id, admission_id, template_id, contract_content, status, resident_signature_url, resident_signature_status, owner_signature_status",
      )
      .eq("id", contractId)
      .eq("resident_id", resident.id)
      .maybeSingle();

    if (contractError || !contract) {
      return jsonError("This contract could not be loaded or does not belong to your account.", 404);
    }

    if (!contract.contract_content || !contract.contract_content.trim()) {
      return jsonError("This contract does not contain complete terms. Please contact management.", 400);
    }

    const admissionId = contract.admission_id;
    if (!admissionId) {
      return jsonError("This contract is not linked to an admission.", 400);
    }

    const { data: admission, error: admissionError } = await supabaseAdmin
      .from("admissions")
      .select("id, resident_id, room_id, bed_id, status")
      .eq("id", admissionId)
      .eq("resident_id", resident.id)
      .maybeSingle();

    if (admissionError || !admission) {
      return jsonError("The admission linked to this contract could not be loaded.", 404);
    }

    const now = new Date().toISOString();

    // 1. Update contract: status = 'Active', resident_signature_status = 'Signed', owner_signature_status = 'Signed'
    const { data: updatedContract, error: contractUpdateError } = await supabaseAdmin
      .from("contracts")
      .update({
        resident_signature_url: signatureUrl,
        resident_signature_status: "Signed",
        owner_signature_status: "Signed",
        owner_signature_name: "Hostel Administration",
        signed_by_resident: true,
        signed_at: now,
        status: "Active",
        updated_at: now,
      })
      .eq("id", contract.id)
      .select()
      .single();

    if (contractUpdateError || !updatedContract) {
      return jsonError(
        getSupabaseErrorMessage(contractUpdateError, "Unable to activate the signed contract."),
        500,
      );
    }

    // 2. Update admission: status = 'Active'
    const { data: updatedAdmission, error: admissionUpdateError } = await supabaseAdmin
      .from("admissions")
      .update({
        status: "Active",
        updated_at: now,
      })
      .eq("id", admission.id)
      .select()
      .single();

    if (admissionUpdateError) {
      console.error("Admission activation warning:", admissionUpdateError);
    }

    // 3. Update resident: status = 'Active'
    const { data: updatedResident, error: residentUpdateError } = await supabaseAdmin
      .from("residents")
      .update({
        status: "Active",
        updated_at: now,
      })
      .eq("id", resident.id)
      .select()
      .single();

    if (residentUpdateError) {
      console.error("Resident activation warning:", residentUpdateError);
    }

    // 4. Update bed: status = 'Occupied'
    if (admission.bed_id) {
      await supabaseAdmin
        .from("beds")
        .update({
          status: "Occupied",
          updated_at: now,
        })
        .eq("id", admission.bed_id);
    }

    // 5. Update room occupancy if room is linked
    if (admission.room_id) {
      try {
        const { data: roomBeds } = await supabaseAdmin
          .from("beds")
          .select("id, status")
          .eq("room_id", admission.room_id);

        if (roomBeds) {
          const occupiedCount = roomBeds.filter((b) => b.status === "Occupied").length;
          const { data: currentRoom } = await supabaseAdmin
            .from("rooms")
            .select("id, total_beds, status")
            .eq("id", admission.room_id)
            .single();

          if (currentRoom && !["Maintenance", "Inactive"].includes(currentRoom.status)) {
            const nextStatus =
              occupiedCount === 0
                ? "Available"
                : occupiedCount >= (currentRoom.total_beds || 1)
                  ? "Occupied"
                  : "Partially Occupied";

            await supabaseAdmin
              .from("rooms")
              .update({
                occupied_beds: occupiedCount,
                status: nextStatus,
                updated_at: now,
              })
              .eq("id", admission.room_id);
          }
        }
      } catch (roomUpdateError) {
        console.error("Room occupancy update error:", roomUpdateError);
      }
    }

    // Trigger notification
    try {
      await notifyResidentEvent("contract_approved", contract.id);
    } catch {
      // Non-blocking
    }

    return NextResponse.json(
      {
        success: true,
        message: "Contract signed successfully! Your resident account and admission are now active.",
        contract: updatedContract,
        admission: updatedAdmission ?? admission,
        resident: updatedResident ?? resident,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to complete contract signing.",
      500,
    );
  }
}
