import { additionalChargeError } from "@/lib/additionalCharges";
import { normalizeIdentityEmail } from "@/lib/identity";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const SAFE_FILE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
}

function bearerToken(request: NextRequest) {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-160) || "receipt";
}

function hasExpectedSignature(bytes: Uint8Array, type: string) {
  if (type === "application/pdf") return bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
}

export async function POST(request: NextRequest) {
  let uploadedPath = "";
  try {
    const token = bearerToken(request);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!token || !supabaseUrl || !anonKey) return errorResponse("Your resident session could not be verified.", 401);

    const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    const email = authData.user?.email?.trim().toLowerCase() ?? "";
    if (authError || !email) return errorResponse("Your resident session could not be verified.", 401);

    const { data: resident, error: residentError } = await supabaseAdmin.from("residents").select("id,status").eq("email", normalizeIdentityEmail(email)).maybeSingle();
    if (residentError || !resident || String(resident.status).toLowerCase() === "archived") return errorResponse("Your resident profile could not be verified.", 403);

    const formData = await request.formData();
    const admissionId = String(formData.get("admissionId") ?? "");
    const rentBillId = String(formData.get("rentBillId") ?? "");
    const depositBillId = String(formData.get("depositBillId") ?? "");
    const includeLateFee = formData.get("includeLateFee") === "true";
    const includeRent = formData.get("includeRent") !== "false";
    const hasAdditional = formData.has("additionalAmount");
    const additionalAmount = String(formData.get("additionalAmount") ?? "");
    const additionalCategory = String(formData.get("additionalCategory") ?? "");
    const additionalDescription = String(formData.get("additionalDescription") ?? "").trim();
    if (hasAdditional) {
      const invalid = additionalChargeError(additionalAmount, additionalCategory, additionalDescription);
      if (invalid) return errorResponse(invalid, 400);
      if (!/^\d+(\.\d{1,2})?$/.test(String(formData.get("amount") ?? ""))) return errorResponse("Submitted total must have at most two decimals.", 400);
      if (includeLateFee) return errorResponse("Submit Late Fee separately using the existing Late Fee payment option.", 400);
    }
    const amount = Math.round(Number(formData.get("amount")) * 100) / 100;
    const paymentMethod = String(formData.get("paymentMethod") ?? "").trim().slice(0, 100);
    const referenceNumber = String(formData.get("referenceNumber") ?? "").trim().slice(0, 120);
    const notes = String(formData.get("notes") ?? "").trim().slice(0, 2000);
    const file = formData.get("file");
    if (!admissionId || (hasAdditional ? (!rentBillId && !depositBillId) : (!rentBillId || (!includeLateFee && !depositBillId))) || !Number.isFinite(amount) || amount <= 0 || !paymentMethod || !(file instanceof File)) return errorResponse("Current obligations, amount, payment method, and receipt file are required.", 400);
    if (includeLateFee && depositBillId && !includeRent) return errorResponse("A deposit plus fine payment must include rent.", 400);
    if (!SAFE_FILE_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_FILE_SIZE) return errorResponse("Receipt files must be PDF, JPEG, or PNG and no larger than 5 MB.", 400);
    const buffer = await file.arrayBuffer();
    if (!hasExpectedSignature(new Uint8Array(buffer).slice(0, 8), file.type)) return errorResponse("The receipt file content does not match its declared file type.", 400);

    if (referenceNumber) {
      const [payments, receipts] = await Promise.all([
        supabaseAdmin.from("payments").select("id").eq("resident_id", resident.id).eq("reference_number", referenceNumber).limit(1),
        supabaseAdmin.from("payment_receipts").select("id").eq("resident_id", resident.id).eq("reference_number", referenceNumber).limit(1),
      ]);
      if (payments.error || receipts.error) return errorResponse("The payment reference could not be checked.", 500);
      if ((payments.data ?? []).length || (receipts.data ?? []).length) return errorResponse("This reference number has already been submitted.", 409);
    }

    uploadedPath = `${resident.id}/combined/${admissionId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
    const { error: uploadError } = await supabaseAdmin.storage.from("payment-receipts").upload(uploadedPath, buffer, { contentType: file.type, cacheControl: "3600", upsert: false });
    if (uploadError) return errorResponse("The receipt file could not be uploaded. Please try again.", 500);
    const purpose = hasAdditional ? [rentBillId ? "Rent" : "", depositBillId ? "Security Deposit" : "", "Additional Charges"].filter(Boolean).join(" + ") : includeLateFee
      ? [includeRent ? "Rent" : "", depositBillId ? "Security Deposit" : "", "Late Fee"].filter(Boolean).join(" + ")
      : "Rent + Security Deposit";
    const receiptNotes = [`Payment method: ${paymentMethod}`, `Payment purpose: ${purpose}`, `Admission ID: ${admissionId}`, notes].filter(Boolean).join("\n");
    const { data, error } = await supabaseAdmin.rpc(hasAdditional ? "create_additional_payment_submission" : includeLateFee ? "create_late_fee_payment_submission" : "create_combined_payment_submission", {
      p_resident_id: resident.id,
      p_admission_id: admissionId,
      p_rent_bill_id: rentBillId || null,
      p_deposit_bill_id: depositBillId || null,
      ...(includeLateFee ? { p_include_rent: includeRent } : {}),
      p_amount: amount,
      ...(hasAdditional ? { p_additional_amount: Number(additionalAmount), p_category: additionalCategory, p_description: additionalDescription } : {}),
      p_payment_method: paymentMethod,
      p_reference_number: referenceNumber,
      p_notes: receiptNotes,
      p_receipt_url: uploadedPath,
      p_original_file_name: file.name.slice(0, 255),
    });
    if (error || !data) {
      await supabaseAdmin.storage.from("payment-receipts").remove([uploadedPath]);
      return errorResponse(error?.message || "The combined payment could not be submitted.", 409);
    }
    return NextResponse.json({ message: "Payment submitted for verification.", ...data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    if (uploadedPath) await supabaseAdmin.storage.from("payment-receipts").remove([uploadedPath]);
    return errorResponse("The combined payment could not be submitted.", 500);
  }
}
