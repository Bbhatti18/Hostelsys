import { NextRequest } from "next/server";
import { apiError, apiJson, requireStaff } from "@/lib/adminApiAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { notifyResidentEvent } from "@/lib/notifications/server";
import { rentDueDate } from "@/lib/billApproval";
import { currentRentMonth } from "@/lib/missingRentPeriods";

const roles = ["admin", "super admin", "accountant"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: unknown) { return typeof value === "string" && uuid.test(value) ? value : null; }

async function missingRentPreview(admissionId: string, month: string) {
  const { data: admission, error } = await supabaseAdmin.from("admissions").select("id,resident_id,admission_date,status,monthly_rent").eq("id", admissionId).maybeSingle();
  if (error || !admission || !["Pending", "Active"].includes(admission.status) || month > currentRentMonth()) throw new Error("Current admission and elapsed/current month required.");
  const dueDate = rentDueDate(admission.admission_date, month);
  const [latest, resident, existing] = await Promise.all([
    supabaseAdmin.from("admissions").select("id").eq("resident_id", admission.resident_id).order("admission_date", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle(),
    supabaseAdmin.from("residents").select("status").eq("id", admission.resident_id).maybeSingle(),
    supabaseAdmin.from("bills").select("id,bill_number,bill_status").eq("admission_id", admissionId).eq("bill_type", "Rent").eq("billing_month", month).limit(1),
  ]);
  if (latest.error || resident.error || existing.error || latest.data?.id !== admissionId || !resident.data || resident.data.status === "Archived") throw new Error("Current resident/admission could not be confirmed.");
  if (existing.data?.length) { const bill = existing.data[0]; throw new Error(`Rent bill already exists for this month. Status: ${bill.bill_status ?? "Unknown"}. Reference: ${bill.bill_number || bill.id}. Refresh the page.${bill.bill_status === "Cancelled" ? " Replacement requires a separate explicitly authorized, audited workflow." : ""}`); }
  let amount = Number(admission.monthly_rent);
  if (!Number.isFinite(amount) || amount <= 0) {
    const contract = await supabaseAdmin.from("contracts").select("monthly_rent").eq("admission_id", admissionId).not("status", "in", "(Cancelled,Terminated)").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
    if (contract.error) throw new Error("Canonical rent amount could not be confirmed.");
    amount = Number(contract.data?.monthly_rent);
  }
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Canonical monthly rent is missing.");
  return { admissionId, month, amount, dueDate };
}

export async function GET(request: NextRequest) {
  const preview = request.nextUrl.searchParams.get("preview") === "missing-rent";
  const { staff, response } = await requireStaff(request, preview ? ["admin", "super admin"] : roles);
  if (!staff) return response;
  if (preview) {
    const admissionId = id(request.nextUrl.searchParams.get("admissionId")), month = request.nextUrl.searchParams.get("month") ?? "";
    if (!admissionId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return apiError("Exact admission and month required.", 400);
    try { return apiJson(await missingRentPreview(admissionId, month)); }
    catch (e) { return apiError(e instanceof Error ? e.message : "Preview unavailable.", 409); }
  }
  if (request.nextUrl.searchParams.get("history") === "true") {
    const { data, error } = await supabaseAdmin.rpc("staff_correction_history", { p_actor: staff.email });
    return error ? apiError(error.message, 409) : apiJson({ corrections: data });
  }
  const payment = id(request.nextUrl.searchParams.get("paymentId"));
  const receipt = id(request.nextUrl.searchParams.get("receiptId"));
  if ((request.nextUrl.searchParams.has("paymentId") && !payment) || (request.nextUrl.searchParams.has("receiptId") && !receipt)) return apiError("Invalid selected payment/receipt ID.", 400);
  if (!payment && !receipt) return apiError("An exact payment or receipt is required.", 400);
  const { data, error } = await supabaseAdmin.rpc("staff_allocation_snapshot", { p_payment: payment, p_receipt: receipt, p_actor: staff.email });
  return error ? apiError(error.message, 409) : apiJson(data);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const correcting = body?.action === "correct" || body?.action === "generate";
  const { staff, response } = await requireStaff(request, correcting ? ["admin", "super admin"] : roles);
  if (!staff) return response;
  if (body?.action === "generate") {
    if (!id(body.admissionId) || typeof body.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month)) return apiError("Exact admission and month required.", 400);
    if (body.confirmed !== true) return apiError("Explicit bill generation confirmation required.", 400);
    try {
      const preview = await missingRentPreview(body.admissionId, body.month);
      if (body.expectedAmount !== preview.amount || body.expectedDueDate !== preview.dueDate) return apiError("Rent amount or due date changed. Reload the preview.", 409);
    } catch (e) { return apiError(e instanceof Error ? e.message : "Preview unavailable.", 409); }
    const { data, error } = await supabaseAdmin.rpc("generate_missing_staff_rent", { p_admission: body.admissionId, p_month: body.month, p_actor: staff.email, p_expected_amount: body.expectedAmount, p_expected_due_date: body.expectedDueDate });
    if (error?.message.includes("Rent bill already exists")) {
      // Another Admin may have generated it after our preview. Reload its reference read-only.
      try { await missingRentPreview(body.admissionId, body.month); }
      catch (e) { return apiError(e instanceof Error ? e.message : error.message, 409); }
    }
    return error ? apiError(error.message, 409) : apiJson({ billId: data, message: "Missing rent generated for approval. Utilities remain in their existing workflow." });
  }
  if (!body || !["verify", "correct"].includes(body.action) || !id(body.requestId) || (!id(body.paymentId) && !id(body.receiptId)) ||
      (body.paymentId != null && !id(body.paymentId)) || (body.receiptId != null && !id(body.receiptId)) ||
      typeof body.fingerprint !== "string" || typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 2000 ||
      !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20 || body.confirmed !== true ||
      (body.feeExceptionReason != null && (body.action !== "correct" || body.feeExceptionConfirmed !== true || typeof body.feeExceptionReason !== "string" || !body.feeExceptionReason.trim()))) {
    return apiError("Explicit allocation, reason and confirmation are required.", 400);
  }
  for (const item of body.items) {
    if (!id(item?.bill_id) || !["Rent", "Security Deposit", "Other Charges"].includes(item.bill_type) ||
        typeof item.amount !== "number" || !Number.isFinite(item.amount) || item.amount <= 0 || Math.abs(Math.round(item.amount * 100) - item.amount * 100) > 0.000001 ||
        typeof item.billing_month !== "string" || typeof item.due_date !== "string") return apiError("Exact bill type, period, due date and positive amount required.", 400);
  }
  const { data, error } = await supabaseAdmin.rpc("apply_staff_payment_allocation", {
    p_request_id: body.requestId, p_payment: id(body.paymentId), p_receipt: id(body.receiptId), p_action: body.action,
    p_items: body.items, p_expected: body.fingerprint, p_reason: body.reason.trim(),
    p_fee_exception_reason: body.feeExceptionReason?.trim() || null, p_actor: staff.email,
  });
  if (error) return apiError(error.message, 409);
  let notificationWarning = false;
  if (body.action === "verify" && body.receiptId && !data?.replayed) {
    // The existing notification resolver supports one bill. Never describe a
    // split allocation as a deposit-only receipt based on historical notes.
    if (data?.notification_supported === false) notificationWarning = true;
    else {
      try { notificationWarning = (await notifyResidentEvent("payment_verified", body.receiptId)).warning; }
      catch { notificationWarning = true; }
    }
  }
  return apiJson({ data, notificationWarning, message: body.action === "correct" ? "Payment corrected with audited replacement credit." : "Selected allocations verified." });
}
