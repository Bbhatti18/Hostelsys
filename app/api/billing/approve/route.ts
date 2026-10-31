import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  BILLING_STAFF_ROLES,
  apiError,
  apiJson,
  requireStaff,
} from "@/lib/adminApiAuth";
import { isUnapprovedBill } from "@/lib/billApproval";
import { buildBillApprovalEmail } from "@/lib/email/billApprovalEmail";
import { sendTransactionalEmail } from "@/lib/email/resendClient";

type ApprovalOutcome = {
  billId: string;
  billNumber: string;
  residentName: string;
  approved: boolean;
  emailStatus: "sent" | "skipped" | "configuration_required" | "failed" | "not_attempted";
  reason: string | null;
};

const APPROVED_STATUS = "Pending";
const MAX_APPROVALS = 200;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function money(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function portalUrl() {
  const base = text(
    process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL,
  ).replace(/\/$/, "");
  return base ? `${base}/resident-portal/bills` : "/resident-portal/bills";
}

function hostelName() {
  return text(process.env.NEXT_PUBLIC_HOSTEL_NAME) || "University Girls Hostel";
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
      return apiError("Select at least one bill to approve.", 400);
    }
    if (billIds.length > MAX_APPROVALS) {
      return apiError(`Approve at most ${MAX_APPROVALS} bills per request.`, 400);
    }

    const { data: bills, error: billsError } = await supabaseAdmin
      .from("bills")
      .select(
        "id, bill_number, resident_id, admission_id, billing_month, due_date, rent_amount, electricity_amount, ac_amount, other_amount, discount_amount, total_amount, paid_amount, balance_amount, bill_status",
      )
      .in("id", billIds);

    if (billsError) {
      return apiError("The selected bills could not be loaded.", 500);
    }

    const foundBills = bills ?? [];
    const residentIds = [...new Set(foundBills.map((bill) => text(bill.resident_id)))];
    const { data: residents, error: residentsError } = residentIds.length
      ? await supabaseAdmin
          .from("residents")
          .select("id, full_name, email, status")
          .in("id", residentIds)
      : { data: [], error: null };

    if (residentsError) {
      return apiError("Resident details for these bills could not be loaded.", 500);
    }

    const residentById = new Map(
      (residents ?? []).map((resident) => [text(resident.id), resident]),
    );
    const outcomes: ApprovalOutcome[] = [];

    for (const billId of billIds) {
      const bill = foundBills.find((row) => text(row.id) === billId);
      if (!bill) {
        outcomes.push({
          billId,
          billNumber: "—",
          residentName: "—",
          approved: false,
          emailStatus: "not_attempted",
          reason: "The bill was not found.",
        });
        continue;
      }

      const resident = residentById.get(text(bill.resident_id));
      const residentName = text(resident?.full_name) || "Resident";
      const billNumber = text(bill.bill_number) || "—";

      if (!isUnapprovedBill(bill.bill_status)) {
        outcomes.push({
          billId,
          billNumber,
          residentName,
          approved: false,
          emailStatus: "not_attempted",
          reason: `This bill is already ${text(bill.bill_status) || "released"}.`,
        });
        continue;
      }

      // Guard on the prior status so two admins approving at once cannot both win.
      const { data: approvedBill, error: approveError } = await supabaseAdmin
        .from("bills")
        .update({
          bill_status: APPROVED_STATUS,
          updated_at: new Date().toISOString(),
        })
        .eq("id", billId)
        .eq("bill_status", bill.bill_status)
        .select("id, bill_status")
        .maybeSingle();

      if (approveError || !approvedBill) {
        outcomes.push({
          billId,
          billNumber,
          residentName,
          approved: false,
          emailStatus: "not_attempted",
          reason: approveError
            ? approveError.message || "The bill could not be approved."
            : "The bill changed before approval completed. Refresh and try again.",
        });
        continue;
      }

      const email = text(resident?.email).toLowerCase();
      if (!email || text(resident?.status).toLowerCase() === "archived") {
        outcomes.push({
          billId,
          billNumber,
          residentName,
          approved: true,
          emailStatus: "skipped",
          reason: email
            ? "Resident is archived, so no email was sent."
            : "Resident has no email address, so no email was sent.",
        });
        continue;
      }

      const { subject, html, text: plain } = buildBillApprovalEmail({
        residentName,
        billNumber,
        billingMonth: text(bill.billing_month).slice(0, 7),
        dueDate: text(bill.due_date).slice(0, 10),
        rentAmount: money(bill.rent_amount),
        electricityAmount: money(bill.electricity_amount),
        acAmount: money(bill.ac_amount),
        otherAmount: money(bill.other_amount),
        discountAmount: money(bill.discount_amount),
        totalAmount: money(bill.total_amount),
        paidAmount: money(bill.paid_amount),
        balanceAmount: money(bill.balance_amount),
        portalUrl: portalUrl(),
        hostelName: hostelName(),
      });

      const dispatch = await sendTransactionalEmail({
        to: email,
        subject,
        html,
        text: plain,
        idempotencyKey: `bill-approved:${billId}`,
      });

      const nowIso = new Date().toISOString();
      await supabaseAdmin
        .from("notification_deliveries")
        .upsert(
          {
            event_key: `bill_generated:${billId}`,
            event_type: "bill_generated",
            entity_id: billId,
            resident_id: text(bill.resident_id),
            requested_channels: ["email"],
            email_status: dispatch.status,
            email_provider_message_id: dispatch.providerMessageId,
            status:
              dispatch.status === "sent"
                ? "complete"
                : dispatch.status === "configuration_required"
                  ? "configuration_required"
                  : "failed",
            last_error_code: dispatch.status === "sent" ? null : dispatch.error,
            completed_at: dispatch.status === "sent" ? nowIso : null,
            updated_at: nowIso,
          },
          { onConflict: "event_key" },
        );

      outcomes.push({
        billId,
        billNumber,
        residentName,
        approved: true,
        emailStatus: dispatch.status,
        reason:
          dispatch.status === "sent"
            ? null
            : dispatch.status === "configuration_required"
              ? "Email is not configured (RESEND_API_KEY / NOTIFICATION_EMAIL_FROM)."
              : dispatch.error,
      });
    }

    const approvedCount = outcomes.filter((outcome) => outcome.approved).length;
    const emailedCount = outcomes.filter((outcome) => outcome.emailStatus === "sent").length;

    console.info("[billing] Bill approval processed.", {
      requested: billIds.length,
      approvedCount,
      emailedCount,
      by: staff.email,
    });

    return apiJson({
      requested: billIds.length,
      approvedCount,
      emailedCount,
      emailConfigurationRequired: outcomes.some(
        (outcome) => outcome.emailStatus === "configuration_required",
      ),
      outcomes,
    });
  } catch (error) {
    console.error("[billing] Unexpected bill approval failure.", error);
    return apiError("The bills could not be approved. Please try again.", 500);
  }
}
