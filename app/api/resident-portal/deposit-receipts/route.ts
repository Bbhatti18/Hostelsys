import { normalizeIdentityEmail } from "@/lib/identity";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { securityDepositReceiptNotes } from "@/lib/paymentReceiptPurpose";
import { notifyResidentEvent } from "@/lib/notifications/server";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const SAFE_FILE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

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

function hasExpectedSignature(bytes: Uint8Array, type: string) {
  if (type === "application/pdf") {
    return bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  }
  if (type === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((byte, index) => bytes[index] === byte);
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-160) || "receipt";
}

export async function POST(request: NextRequest) {
  let uploadedPath = "";
  try {
    const token = bearerToken(request);
    if (!token) return jsonError("Please sign in to submit a receipt.", 401);

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
      return jsonError("Please sign in to submit a receipt.", 401);
    }

    const metadataResidentId =
      typeof user.user_metadata?.resident_id === "string"
        ? user.user_metadata.resident_id.trim()
        : "";
    let residentQuery = supabaseAdmin
      .from("residents")
      .select("id, status")
      .eq("email", normalizeIdentityEmail(email));
    if (metadataResidentId) residentQuery = residentQuery.eq("id", metadataResidentId);
    const { data: resident, error: residentError } = await residentQuery.maybeSingle();
    if (residentError || !resident) {
      return jsonError("Your resident profile could not be verified.", 403);
    }
    if (String(resident.status ?? "").trim().toLowerCase() === "archived") {
      return jsonError("Archived residents cannot submit receipts.", 403);
    }

    const formData = await request.formData();
    const requestedAdmissionId = String(formData.get("admissionId") ?? "");
    const submittedAmount = Math.round(Number(formData.get("amount")) * 100) / 100;
    if (!requestedAdmissionId || !Number.isFinite(submittedAmount) || submittedAmount <= 0) return jsonError("Admission and a positive amount are required.", 400);
    const { data: admission, error: admissionError } = await supabaseAdmin
      .from("admissions")
      .select("id, resident_id, security_deposit, deposit_status, status")
      .eq("resident_id", resident.id)
      .eq("id", requestedAdmissionId)
      .in("status", ["Pending", "Active"])
      .in("deposit_status", ["Pending", "Held"])
      .gt("security_deposit", 0)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (admissionError) {
      return jsonError("Your security deposit obligation could not be verified.", 500);
    }
    if (!admission) {
      return jsonError("No outstanding security deposit is available for payment.", 409);
    }

    const file = formData.get("file");
    const paymentMethod = String(formData.get("paymentMethod") ?? "").trim().slice(0, 100);
    const referenceNumber = String(formData.get("referenceNumber") ?? "").trim().slice(0, 120);
    const residentNotes = String(formData.get("notes") ?? "").trim().slice(0, 2000);
    if (!(file instanceof File) || !paymentMethod) {
      return jsonError("Payment method and receipt file are required.", 400);
    }
    if (!SAFE_FILE_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_FILE_SIZE) {
      return jsonError("Receipt files must be PDF, JPEG, or PNG and no larger than 5 MB.", 400);
    }
    const fileBuffer = await file.arrayBuffer();
    if (!hasExpectedSignature(new Uint8Array(fileBuffer).slice(0, 8), file.type)) {
      return jsonError("The receipt file content does not match its declared file type.", 400);
    }

    const { data: depositBill, error: billError } = await supabaseAdmin.from("bills")
      .select("id,total_amount,bill_status").eq("admission_id", admission.id).eq("resident_id", resident.id)
      .eq("bill_type", "Security Deposit").neq("bill_status", "Cancelled").maybeSingle();
    if (billError || !depositBill || ["Draft", "Pending Approval"].includes(depositBill.bill_status)) return jsonError("A released deposit bill for this admission is required.", 409);
    const { data: paid, error: paidError } = await supabaseAdmin.from("payments").select("amount")
      .eq("bill_id", depositBill.id).eq("payment_status", "Verified");
    if (paidError) return jsonError("The deposit balance could not be checked.", 500);
    const outstanding = Math.round((Number(depositBill.total_amount) - (paid ?? []).reduce((sum, row) => sum + Number(row.amount), 0)) * 100) / 100;
    if (submittedAmount > outstanding) return jsonError("Amount exceeds this admission's outstanding deposit.", 409);
    if (submittedAmount < outstanding) return jsonError("Use Pay an Obligation / Payment Commitments for a partial deposit and acknowledge the remainder.",409);
    const { data: existingReceipt, error: existingError } = await supabaseAdmin.from("payment_receipts")
      .select("id").eq("bill_id", depositBill.id).eq("status", "Pending Verification").limit(1).maybeSingle();
    if (existingError || existingReceipt) return jsonError("A deposit proof is already pending or could not be checked.", 409);

    if (referenceNumber) {
      const [paymentReference, receiptReference] = await Promise.all([
        supabaseAdmin.from("payments").select("id").eq("reference_number", referenceNumber).limit(1),
        supabaseAdmin.from("payment_receipts").select("id").eq("reference_number", referenceNumber).limit(1),
      ]);
      if (paymentReference.error || receiptReference.error) {
        return jsonError("The payment reference could not be checked.", 500);
      }
      if ((paymentReference.data ?? []).length || (receiptReference.data ?? []).length) {
        return jsonError("This reference number has already been submitted.", 409);
      }
    }

    uploadedPath = `${resident.id}/security-deposits/${admission.id}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("payment-receipts")
      .upload(uploadedPath, fileBuffer, { contentType: file.type, cacheControl: "3600", upsert: false });
    if (uploadError) return jsonError("The receipt file could not be uploaded. Please try again.", 500);

    const now = new Date().toISOString();
    const receiptPayload = {
      resident_id: resident.id,
      bill_id: depositBill.id,
      payment_id: null,
      receipt_url: uploadedPath,
      original_file_name: file.name.slice(0, 255),
      reference_number: referenceNumber || null,
      amount: submittedAmount,
      status: "Pending Verification",
      verified: false,
      verified_by: null,
      verified_at: null,
      remarks: null,
      notes: securityDepositReceiptNotes(admission.id, paymentMethod, residentNotes),
      uploaded_at: now,
      created_at: now,
      updated_at: now,
    };

    const receiptResult = await supabaseAdmin.from("payment_receipts").insert(receiptPayload).select("id").single();

    if (receiptResult.error || !receiptResult.data) {
      await supabaseAdmin.storage.from("payment-receipts").remove([uploadedPath]);
      uploadedPath = "";
      return jsonError(
        "A security deposit receipt is already pending or the submission changed. Refresh and review its status.",
        409,
      );
    }

    const notification = await notifyResidentEvent("receipt_submitted", receiptResult.data.id);
    return NextResponse.json(
      {
        message: "Security deposit receipt submitted for verification. Your deposit remains Pending until an admin verifies it.",
        notificationWarning: notification.warning,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    if (uploadedPath) {
      await supabaseAdmin.storage.from("payment-receipts").remove([uploadedPath]);
    }
    return jsonError("The security deposit receipt could not be submitted.", 500);
  }
}
