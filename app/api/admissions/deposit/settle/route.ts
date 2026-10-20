import { NextRequest } from "next/server";
import { apiError, apiJson, requireStaff } from "@/lib/adminApiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  DepositRefundType,
  DepositSettlementRecord,
  embedDepositSettlementNote,
} from "@/lib/depositSettlement";

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
      admissionId?: unknown;
      billId?: unknown;
      refundType?: unknown;
      refundAmount?: unknown;
      deductedAmount?: unknown;
      deductionReason?: unknown;
      refundMethod?: unknown;
      settlementDate?: unknown;
      notes?: unknown;
    } | null;

    let admissionId = typeof body?.admissionId === "string" ? body.admissionId.trim() : "";
    const billId = typeof body?.billId === "string" ? body.billId.trim() : "";

    // If billId provided without admissionId, look up admissionId from bill
    if (!admissionId && billId) {
      const { data: bill } = await supabaseAdmin
        .from("bills")
        .select("admission_id")
        .eq("id", billId)
        .maybeSingle();
      if (bill?.admission_id) {
        admissionId = String(bill.admission_id);
      }
    }

    if (!admissionId) {
      return apiError("Admission ID or Deposit Bill ID is required.", 400);
    }

    const refundType = body?.refundType as DepositRefundType | undefined;
    if (
      refundType !== "Fully Refunded" &&
      refundType !== "Partially Refunded" &&
      refundType !== "No Refund"
    ) {
      return apiError(
        "Invalid refund option. Must be 'Fully Refunded', 'Partially Refunded', or 'No Refund'.",
        400,
      );
    }

    let totalDeposit = 0;
    let existingNotes: string | null = null;
    let admission: { id: string; resident_id: string; security_deposit: number; deposit_status: string; status: string; notes: string | null } | null = null;

    if (admissionId) {
      const { data: adm, error: admErr } = await supabaseAdmin
        .from("admissions")
        .select("id, resident_id, security_deposit, deposit_status, status, notes")
        .eq("id", admissionId)
        .maybeSingle();

      if (admErr || !adm) {
        return apiError("Admission record could not be found.", 404);
      }
      admission = adm;
      totalDeposit = Number(adm.security_deposit || 0);
      existingNotes = adm.notes;
    } else if (billId) {
      const { data: b, error: bErr } = await supabaseAdmin
        .from("bills")
        .select("id, total_amount, paid_amount, notes")
        .eq("id", billId)
        .maybeSingle();
      if (bErr || !b) {
        return apiError("Deposit bill record could not be found.", 404);
      }
      totalDeposit = Number(b.paid_amount || b.total_amount || 0);
      existingNotes = b.notes;
    } else {
      return apiError("Admission ID or Deposit Bill ID is required.", 400);
    }

    const totalDepositAmount = totalDeposit;
    const refundAmount = Number(body?.refundAmount ?? 0);
    const deductedAmount = Number(body?.deductedAmount ?? 0);
    const deductionReason = typeof body?.deductionReason === "string" ? body.deductionReason.trim() : "";
    const refundMethod = typeof body?.refundMethod === "string" ? body.refundMethod.trim() : "Cash";
    const settlementDate = typeof body?.settlementDate === "string" && body.settlementDate.trim()
      ? body.settlementDate.trim()
      : new Date().toISOString();
    const customNotes = typeof body?.notes === "string" ? body.notes.trim() : "";

    // Validations
    if (refundType === "Fully Refunded") {
      if (refundAmount < 0) {
        return apiError("Refund amount must be a non-negative number.", 400);
      }
    } else if (refundType === "Partially Refunded") {
      if (refundAmount <= 0) {
        return apiError("Partially Refunded option requires a positive refund amount.", 400);
      }
      if (deductedAmount <= 0) {
        return apiError("Partially Refunded option requires a positive deducted amount.", 400);
      }
      if (!deductionReason) {
        return apiError("Please provide a reason for the deduction in partial refund.", 400);
      }
    } else if (refundType === "No Refund") {
      if (deductedAmount <= 0 && totalDepositAmount > 0) {
        return apiError("No Refund option requires the deducted amount to match the deposit.", 400);
      }
      if (!deductionReason) {
        return apiError("Please provide a reason why no refund is being issued.", 400);
      }
    }

    // Prepare settlement record
    const settlementRecord: DepositSettlementRecord = {
      refundType,
      depositAmount: totalDepositAmount,
      refundAmount: refundType === "No Refund" ? 0 : refundAmount,
      deductedAmount: refundType === "Fully Refunded" ? 0 : deductedAmount,
      deductionReason: deductionReason || undefined,
      refundMethod,
      settledAt: settlementDate,
      settledBy: auth.staff.email,
      notes: customNotes || undefined,
    };

    // Determine database deposit_status ('Released' for full refund, 'Deducted' for partial/no refund)
    const newDbDepositStatus = refundType === "Fully Refunded" ? "Released" : "Deducted";

    let updatedAdmission = null;
    if (admission && admissionId) {
      // Update admissions table
      const updatedAdmissionNotes = embedDepositSettlementNote(admission.notes, settlementRecord);
      const { data: updatedAdm, error: updateAdmErr } = await supabaseAdmin
        .from("admissions")
        .update({
          deposit_status: newDbDepositStatus,
          notes: updatedAdmissionNotes,
          updated_at: new Date().toISOString(),
        })
        .eq("id", admissionId)
        .select()
        .single();

      if (updateAdmErr) {
        console.error("[deposit-settle] Error updating admission:", updateAdmErr);
        return apiError(updateAdmErr.message || "Failed to update deposit status on admission.", 400);
      }
      updatedAdmission = updatedAdm;

      // Update linked bills table if exists
      const { data: depositBills } = await supabaseAdmin
        .from("bills")
        .select("id, notes")
        .eq("admission_id", admissionId)
        .eq("bill_type", "Security Deposit");

      if (depositBills && depositBills.length > 0) {
        for (const bill of depositBills) {
          const updatedBillNotes = embedDepositSettlementNote(bill.notes, settlementRecord);
          await supabaseAdmin
            .from("bills")
            .update({
              notes: updatedBillNotes,
              updated_at: new Date().toISOString(),
            })
            .eq("id", bill.id);
        }
      }
    }

    // Also update direct bill if billId provided
    if (billId) {
      const { data: directBill } = await supabaseAdmin
        .from("bills")
        .select("id, notes")
        .eq("id", billId)
        .maybeSingle();

      if (directBill) {
        const updatedBillNotes = embedDepositSettlementNote(directBill.notes, settlementRecord);
        await supabaseAdmin
          .from("bills")
          .update({
            notes: updatedBillNotes,
            updated_at: new Date().toISOString(),
          })
          .eq("id", billId);
      }
    }

    return apiJson({
      success: true,
      message: `Security deposit released as ${refundType}.`,
      depositStatus: newDbDepositStatus,
      settlement: settlementRecord,
      admission: updatedAdmission,
    });
  } catch (err) {
    console.error("[deposit-settle:api] Unexpected error:", err);
    return apiError("Internal server error while settling deposit.", 500);
  }
}
