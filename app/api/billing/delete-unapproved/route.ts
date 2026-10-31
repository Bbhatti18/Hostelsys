import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  BILLING_STAFF_ROLES,
  apiError,
  apiJson,
  requireStaff,
} from "@/lib/adminApiAuth";
import { isUnapprovedBill } from "@/lib/billApproval";

const MAX_DELETES = 200;

function text(value: unknown) {
  return String(value ?? "").trim();
}

export async function POST(request: NextRequest) {
  try {
    const { staff, response } = await requireStaff(request, BILLING_STAFF_ROLES);
    if (!staff) return response;

    const body = (await request.json().catch(() => null)) as
      | { billIds?: unknown }
      | null;
    const billIds = Array.isArray(body?.billIds)
      ? [
          ...new Set(
            body.billIds
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ]
      : [];

    if (billIds.length === 0) {
      return apiError("Select at least one pending bill to delete.", 400);
    }
    if (billIds.length > MAX_DELETES) {
      return apiError(`Delete at most ${MAX_DELETES} bills per request.`, 400);
    }

    // 1. Fetch the targeted bills
    const { data: bills, error: billsError } = await supabaseAdmin
      .from("bills")
      .select("id, bill_number, bill_status, paid_amount, bill_type")
      .in("id", billIds);

    if (billsError) {
      console.error("[delete-unapproved] Failed to fetch bills:", billsError);
      return apiError("The selected bills could not be loaded.", 500);
    }

    const foundBills = bills ?? [];
    if (foundBills.length === 0) {
      return apiError("None of the selected bills were found.", 404);
    }

    // 2. Validate that every bill is truly an unapproved bill
    const invalidBills = foundBills.filter((b) => !isUnapprovedBill(b.bill_status));
    if (invalidBills.length > 0) {
      return apiError(
        `Only pending approval bills can be deleted. ${invalidBills.length} bill(s) are already released or approved.`,
        400,
      );
    }

    // 3. Prevent deleting if any payment is linked
    const paidBills = foundBills.filter((b) => Number(b.paid_amount || 0) > 0);
    if (paidBills.length > 0) {
      return apiError(
        "Bills with payments cannot be deleted. Please reconcile them first.",
        400,
      );
    }

    const validIds = foundBills.map((b) => text(b.id)).filter(Boolean);

    // 4. Safely unlink meter readings in ac_bills so foreign key constraint does not block deletion
    const { error: meterUnlinkError } = await supabaseAdmin
      .from("ac_bills")
      .update({ bill_id: null, updated_at: new Date().toISOString() })
      .in("bill_id", validIds);

    if (meterUnlinkError) {
      console.error("[delete-unapproved] Failed to unlink ac_bills:", meterUnlinkError);
    }

    // 5. Clean up any auxiliary records if any were created
    await supabaseAdmin
      .from("late_fees")
      .delete()
      .in("bill_id", validIds);

    await supabaseAdmin
      .from("payment_followups")
      .delete()
      .in("bill_id", validIds);

    // 6. Delete or retire the unapproved bills
    const deletedIds: string[] = [];
    const cancelledIds: string[] = [];
    const failedIds: string[] = [];

    for (const billId of validIds) {
      const { error: deleteErr } = await supabaseAdmin
        .from("bills")
        .delete()
        .eq("id", billId);

      if (!deleteErr) {
        deletedIds.push(billId);
        continue;
      }

      // If hard delete is restricted (e.g. payment_allocations from a rejected payment),
      // transition to Cancelled so the obligation is safely retired and removed from Awaiting Approval
      // without violating immutable payment ledger constraints.
      const { error: cancelErr } = await supabaseAdmin
        .from("bills")
        .update({
          bill_status: "Cancelled",
          updated_at: new Date().toISOString(),
        })
        .eq("id", billId);

      if (!cancelErr) {
        cancelledIds.push(billId);
      } else {
        console.error(
          `[delete-unapproved] Failed to delete or cancel bill ${billId}:`,
          deleteErr,
          cancelErr,
        );
        failedIds.push(billId);
      }
    }

    if (
      deletedIds.length === 0 &&
      cancelledIds.length === 0 &&
      failedIds.length > 0
    ) {
      return apiError(
        "The selected bills could not be deleted due to database constraints.",
        500,
      );
    }

    return apiJson({
      success: true,
      deletedCount: deletedIds.length + cancelledIds.length,
      deletedIds: [...deletedIds, ...cancelledIds],
    });
  } catch (error) {
    console.error("[delete-unapproved] Unexpected error:", error);
    return apiError("An unexpected error occurred while deleting pending bills.", 500);
  }
}
