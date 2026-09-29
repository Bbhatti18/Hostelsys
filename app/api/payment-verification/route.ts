import { normalizeIdentityEmail } from "@/lib/identity";
import { paymentBillAmounts } from "@/lib/paymentAllocations";
import { receiptPurposeError } from "@/lib/paymentObligations";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { notifyResidentEvent } from "@/lib/notifications/server";
import { securityDepositAdmissionId } from "@/lib/paymentReceiptPurpose";
import { isUnapprovedBill } from "@/lib/billApproval";

const ALLOWED_STAFF_ROLES = new Set([
  "super admin",
  "admin",
  "accountant",
]);

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

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

function isSecurityDepositBill(bill: {
  bill_type?: unknown;
  billing_month?: unknown;
  bill_number?: unknown;
}) {
  return (
    normalized(bill.bill_type) === "security deposit"
  );
}

export async function POST(request: NextRequest) {
  try {
    const token = bearerToken(request);
    if (!token) return jsonError("Your admin session could not be verified.", 401);

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return jsonError("Supabase server configuration is incomplete.", 500);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } =
      await authClient.auth.getUser(token);
    const verifier = authData.user?.email?.trim().toLowerCase() ?? "";
    if (authError || !verifier) {
      return jsonError("Your admin session could not be verified.", 401);
    }

    const { data: staff, error: staffError } = await supabaseAdmin
      .from("staff_users")
      .select("id, role, status")
      .eq("email", normalizeIdentityEmail(verifier))
      .maybeSingle();
    if (
      staffError ||
      !staff ||
      normalized(staff.status) !== "active" ||
      !ALLOWED_STAFF_ROLES.has(normalized(staff.role))
    ) {
      return jsonError(
        "You do not have permission to verify resident payments.",
        403,
      );
    }

    const body = (await request.json().catch(() => null)) as
      | { receiptId?: unknown; action?: unknown; rejectionReason?: unknown }
      | null;
    const receiptId =
      typeof body?.receiptId === "string" ? body.receiptId.trim() : "";
    const action = body?.action === "Verify" || body?.action === "Reject"
      ? body.action
      : null;
    const rejectionReason =
      typeof body?.rejectionReason === "string"
        ? body.rejectionReason.trim()
        : "";

    if (!receiptId || !action) {
      return jsonError("A valid receipt and verification action are required.", 400);
    }
    if (action === "Reject" && !rejectionReason) {
      return jsonError("A rejection reason is required.", 400);
    }

    const { data: receipt, error: receiptError } = await supabaseAdmin
      .from("payment_receipts")
      .select(
        "id, resident_id, bill_id, payment_id, amount, reference_number, status, notes, remarks, verified_at",
      )
      .eq("id", receiptId)
      .maybeSingle();
    if (receiptError || !receipt) {
      return jsonError("The receipt could not be verified.", 404);
    }
    const depositAdmissionId = receipt.bill_id
      ? null
      : securityDepositAdmissionId(receipt.notes);

    let linkedPaymentError = null;
    const linkedPayments = [];
    if (receipt.payment_id) {
      const { data, error } = await supabaseAdmin
        .from("payments")
        .select("id, resident_id, bill_id, amount, payment_status")
        .eq("id", receipt.payment_id)
        .limit(2);
      if (error) {
        linkedPaymentError = error;
      } else if (data) {
        linkedPayments.push(...data);
      }
    }

    if (linkedPaymentError) {
      return jsonError("The linked payment could not be checked.", 500);
    }
    if ((linkedPayments ?? []).length > 1) {
      return jsonError(
        "Multiple payments are linked to this receipt. Resolve the financial conflict before continuing.",
        409,
      );
    }
    const existingPayment = linkedPayments?.[0] ?? null;

    if (receipt.status !== "Pending Verification") {
      if (
        action === "Verify" &&
        receipt.status === "Verified" &&
        existingPayment?.payment_status === "Verified"
      ) {
        return NextResponse.json(
          { message: "This receipt was already verified.", alreadyProcessed: true },
          { headers: { "Cache-Control": "private, no-store" } },
        );
      }
      return jsonError(
        `This receipt is already ${receipt.status}. No second action was applied.`,
        409,
      );
    }

    if (action === "Reject") {
      if (existingPayment?.bill_id === null && existingPayment.id === receipt.payment_id) {
        const { error: combinedRejectError } = await supabaseAdmin.rpc("reject_payment_with_allocations", {
          p_payment_id: existingPayment.id,
          p_receipt_id: receipt.id,
          p_actor: verifier,
          p_reason: rejectionReason,
        });
        if (combinedRejectError) return jsonError(combinedRejectError.message, 409);
        const notification = await notifyResidentEvent("payment_rejected", receipt.id);
        return NextResponse.json({ message: "Payment rejected. No amount was applied; any fine freeze was released.", notificationWarning: notification.warning }, { headers: { "Cache-Control": "private, no-store" } });
      }
      if (existingPayment?.payment_status === "Verified") {
        return jsonError(
          "This receipt already has a verified payment and cannot be rejected.",
          409,
        );
      }

      const { error: rejectionError } = await supabaseAdmin.rpc("reject_single_payment_receipt", {
        p_receipt_id: receipt.id, p_actor: verifier, p_reason: rejectionReason,
      });
      if (rejectionError) return jsonError(rejectionError.message || "Receipt changed before rejection.", 409);

      const notification = await notifyResidentEvent(
        "payment_rejected",
        receipt.id,
      );
      return NextResponse.json(
        {
          message: depositAdmissionId
            ? "Security deposit receipt rejected. The admission deposit remains Pending."
            : "Receipt rejected. No amount was applied to the bill.",
          notificationWarning: notification.warning,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    if (existingPayment?.bill_id === null && existingPayment.id === receipt.payment_id) {
      const { data: verified, error: combinedVerifyError } = await supabaseAdmin.rpc("verify_payment_with_allocations", {
        p_payment_id: existingPayment.id,
        p_receipt_id: receipt.id,
        p_verifier: verifier,
      });
      if (combinedVerifyError || !verified) return jsonError(combinedVerifyError?.message || "The combined payment could not be verified.", 409);
      const notification = await notifyResidentEvent("payment_verified", receipt.id);
      return NextResponse.json({ message: "Payment verified and allocated balances refreshed.", billSummaryUpdated: true, notificationWarning: notification.warning }, { headers: { "Cache-Control": "private, no-store" } });
    }

    if (depositAdmissionId) {
      // Legacy unlinked proofs enter the same guarded verification path as bill receipts.
      const { data: admission, error: admissionError } = await supabaseAdmin
        .from("admissions").select("id, resident_id, status, deposit_status")
        .eq("id", depositAdmissionId).eq("resident_id", receipt.resident_id)
        .in("status", ["Pending", "Active"]).maybeSingle();
      if (admissionError || !admission || !["Pending", "Held"].includes(admission.deposit_status)) {
        return jsonError("The deposit does not belong to a current unpaid admission.", 409);
      }
      const { data: depositBill, error: depositBillError } = await supabaseAdmin
        .from("bills").select("id").eq("admission_id", admission.id)
        .eq("resident_id", receipt.resident_id).eq("bill_type", "Security Deposit")
        .neq("bill_status", "Cancelled").maybeSingle();
      if (depositBillError || !depositBill) return jsonError("Create or repair the admission's deposit bill before verifying this proof.", 409);
      const { data: linked, error: linkError } = await supabaseAdmin.from("payment_receipts")
        .update({ bill_id: depositBill.id }).eq("id", receipt.id)
        .is("bill_id", null).eq("status", "Pending Verification").select("id").maybeSingle();
      if (linkError || !linked) return jsonError("Receipt changed; refresh before verifying.", 409);
      receipt.bill_id = depositBill.id;
    }

    if (!receipt.bill_id) {
      return jsonError("This receipt is not linked to a bill.", 400);
    }

    const { data: bill, error: billError } = await supabaseAdmin
      .from("bills")
      .select(
        "id, resident_id, admission_id, total_amount, paid_amount, balance_amount, due_date, bill_status, bill_type, billing_month, bill_number, rent_amount, electricity_amount, ac_amount, other_amount, discount_amount",
      )
      .eq("id", receipt.bill_id)
      .maybeSingle();
    if (
      billError ||
      !bill ||
      bill.resident_id !== receipt.resident_id ||
      isUnapprovedBill(bill.bill_status) ||
      ["cancelled", "archived"].includes(normalized(bill.bill_status))
    ) {
      return jsonError(
        "The receipt is not linked to a valid payable bill for this resident.",
        409,
      );
    }

    if (!bill.admission_id) return jsonError("Deposit bill requires its admission.", 409);
    if (bill.admission_id) {
      const { data: admission, error: admissionError } = await supabaseAdmin
        .from("admissions")
        .select("id, resident_id, status, deposit_status")
        .eq("id", bill.admission_id)
        .maybeSingle();
      if (
        admissionError ||
        !admission ||
        admission.resident_id !== receipt.resident_id ||
        (isSecurityDepositBill(bill) && (!["Pending", "Active"].includes(admission.status) || admission.deposit_status !== "Pending"))
      ) {
        return jsonError(
          "The bill admission is not linked to the receipt resident.",
          409,
        );
      }
    }

    const receiptAmount = roundMoney(Number(receipt.amount ?? 0));
    const { data: verifiedPayments, error: verifiedPaymentsError } =
      await supabaseAdmin
        .from("payments")
        .select("id, bill_id, amount, payment_status, payment_allocations(bill_id,amount)")
        .eq("payment_status", "Verified");
    if (verifiedPaymentsError) {
      return jsonError("The current bill balance could not be confirmed.", 500);
    }
    const effectivePayments = (verifiedPayments ?? []).flatMap(payment =>
      paymentBillAmounts(payment, payment.payment_allocations ?? []).filter(a => a.bill_id === bill.id)
        .map(a => ({ id: payment.id, bill_id: bill.id, amount: a.amount, payment_status: "Verified" })));
    const verifiedTotal = roundMoney(
      effectivePayments.reduce(
        (sum, payment) => sum + Number(payment.amount ?? 0),
        0,
      ),
    );
    const total = roundMoney(Number(bill.total_amount ?? 0));
    const outstanding = Math.max(roundMoney(total - verifiedTotal), 0);
    if (!Number.isFinite(receiptAmount) || receiptAmount <= 0 || receiptAmount > outstanding) {
      return jsonError(
        "The receipt amount must be positive and cannot exceed the current outstanding balance.",
        409,
      );
    }

    const purpose = String(receipt.notes ?? "").match(/^Payment purpose:[ \t]*(.+)$/im)?.[1]?.trim() ?? "";
    const notedAdmission = String(receipt.notes ?? "").match(/^Admission ID:[ \t]*(.+)$/im)?.[1]?.trim();
    if (notedAdmission && notedAdmission !== bill.admission_id) return jsonError("Receipt admission does not match its bill.", 409);
    if (purpose) {
      const purposeError = receiptPurposeError(bill, effectivePayments, receiptAmount, purpose);
      if (purposeError) return jsonError(purposeError, 409);
    }
    if (receipt.reference_number) {
      let referenceQuery = supabaseAdmin
        .from("payments")
        .select("id")
        .eq("reference_number", receipt.reference_number)
        .limit(1);
      if (existingPayment?.id) {
        referenceQuery = referenceQuery.neq("id", existingPayment.id);
      }
      const { data: duplicateReference, error: referenceError } =
        await referenceQuery;
      if (referenceError) {
        return jsonError("The payment reference could not be checked.", 500);
      }
      if ((duplicateReference ?? []).length > 0) {
        return jsonError(
          "This reference number is already linked to another payment.",
          409,
        );
      }
    }

    if (existingPayment) {
      const matchesReceipt =
        existingPayment.payment_status === "Pending" &&
        existingPayment.resident_id === receipt.resident_id &&
        existingPayment.bill_id === receipt.bill_id &&
        roundMoney(Number(existingPayment.amount ?? 0)) === receiptAmount;
      if (!matchesReceipt) {
        return jsonError(
          "The linked payment does not match this receipt.",
          409,
        );
      }
    }

    const { data: verified, error: verificationError } = await supabaseAdmin.rpc("verify_single_payment_receipt", {
      p_receipt_id: receipt.id, p_verifier: verifier,
    });
    if (verificationError || !verified) return jsonError(verificationError?.message || "Receipt changed before verification.", 409);

    const notification = await notifyResidentEvent(
      "payment_verified",
      receipt.id,
    );
    return NextResponse.json(
      {
        message: "Receipt verified, payment recorded, and bill balance refreshed.",
        billSummaryUpdated: true,
        notificationWarning: notification.warning,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return jsonError("The receipt verification request could not be completed.", 500);
  }
}
