import { additionalChargeError } from "@/lib/additionalCharges";
import { normalizeIdentityEmail } from "@/lib/identity";
import { allocatedPaymentLabel } from "@/lib/paymentReceiptPurpose";
import { roundMoney } from "@/lib/financialMath";
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
    if (authData.user?.user_metadata?.resident_id && authData.user.user_metadata.resident_id !== resident.id) return errorResponse("Resident identity mismatch.", 403);

    const formData = await request.formData();
    const admissionId = String(formData.get("admissionId") ?? "");
    const rentBillId = String(formData.get("rentBillId") ?? "");
    const rentBillingMonth = String(formData.get("rentBillingMonth") ?? "");
    const depositBillId = String(formData.get("depositBillId") ?? "");
    const includeLateFee = formData.get("includeLateFee") === "true";
    const includeRent = formData.get("includeRent") !== "false";
    const hasAdditional = formData.has("additionalAmount");
    const historical = formData.get("historical") === "true";
    const isPartial = formData.has("obligationItems");
    if (historical && (isPartial || hasAdditional || includeLateFee)) return errorResponse("Historical evidence cannot allocate to current obligations.",400);
    if (isPartial && (hasAdditional || includeLateFee)) return errorResponse("Submit new Additional Charges or Late Fees through their existing workflow.", 400);
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
    if ((!historical && !admissionId) || (!historical && !isPartial && !hasAdditional && (!rentBillId || (!includeLateFee && !depositBillId))) || !Number.isFinite(amount) || amount <= 0 || !paymentMethod || !(file instanceof File)) return errorResponse("Current obligations, amount, payment method, and receipt file are required.", 400);
    if (!/^\d+(\.\d{1,2})?$/.test(String(formData.get("amount") || ""))) return errorResponse("Amount must have at most two decimals.",400);
    if (includeLateFee && depositBillId && !includeRent) return errorResponse("A deposit plus fine payment must include rent.", 400);
    if (!SAFE_FILE_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_FILE_SIZE) return errorResponse("Receipt files must be PDF, JPEG, or PNG and no larger than 5 MB.", 400);
    const buffer = await file.arrayBuffer();
    if (!hasExpectedSignature(new Uint8Array(buffer).slice(0, 8), file.type)) return errorResponse("The receipt file content does not match its declared file type.", 400);

    if (referenceNumber && !historical) {
      const [payments, receipts] = await Promise.all([
        supabaseAdmin.from("payments").select("id").eq("resident_id", resident.id).eq("reference_number", referenceNumber).limit(1),
        supabaseAdmin.from("payment_receipts").select("id").eq("resident_id", resident.id).eq("reference_number", referenceNumber).limit(1),
      ]);
      if (payments.error || receipts.error) return errorResponse("The payment reference could not be checked.", 500);
      if ((payments.data ?? []).length || (receipts.data ?? []).length) return errorResponse("This reference number has already been submitted.", 409);
    }

    let obligationItems: { bill_id: string; amount: number; purpose: string; billing_month: string }[] = [];
    let selectedPurpose = "";
    if (!historical) {
      if (isPartial) {
        try { obligationItems = JSON.parse(String(formData.get("obligationItems"))); }
        catch { return errorResponse("Select explicit payment obligations.", 400); }
        if (!Array.isArray(obligationItems) || obligationItems.length < 1 || obligationItems.length > 2
          || obligationItems.some(item => !item || typeof item.bill_id !== 'string' || !Number.isFinite(item.amount) || item.amount <= 0 || roundMoney(item.amount) !== item.amount)
          || new Set(obligationItems.map(item=>item.bill_id)).size !== obligationItems.length
          || roundMoney(obligationItems.reduce((sum,item)=>sum+item.amount,0)) !== amount) return errorResponse("Invalid selected obligations or payment total.", 400);
      }
      const selectedIds = isPartial ? obligationItems.map(item=>item.bill_id) : [rentBillId,depositBillId].filter(Boolean);
      const { data: admission, error: admissionError } = await supabaseAdmin.from('admissions')
        .select('id,status,security_deposit,deposit_status').eq('resident_id',resident.id)
        .order('admission_date',{ascending:false}).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(1).maybeSingle();
      if (admissionError || !admission || admission.id !== admissionId || !['Pending','Active'].includes(admission.status)) return errorResponse("The selected admission is no longer current.",409);
      const { data: bills, error: billsError } = selectedIds.length ? await supabaseAdmin.from('bills')
        .select('id,resident_id,admission_id,bill_type,billing_month,bill_status,total_amount')
        .in('id',selectedIds).eq('resident_id',resident.id).eq('admission_id',admissionId) : {data:[],error:null};
      if (billsError || !bills || bills.length !== selectedIds.length || new Set(selectedIds).size !== selectedIds.length) return errorResponse("A selected bill does not belong to your current admission.",409);
      if (isPartial && bills.length===2 && !['Rent','Security Deposit'].every(type=>bills.some(b=>b.bill_type===type))) return errorResponse("Combine one Rent bill with one Security Deposit bill.",409);
      let selectedTotal = 0;
      for (const bill of bills) {
        const item = obligationItems.find(item=>item.bill_id===bill.id);
        const expectedPurpose = isPartial ? item?.purpose : bill.id===rentBillId ? 'Rent' : 'Security Deposit';
        const actualPurpose = bill.bill_type==='Other Charges' ? 'Additional Charges' : bill.bill_type;
        if (!['Pending','Partially Paid','Overdue'].includes(bill.bill_status) && !(includeLateFee && !includeRent && bill.bill_status==='Paid')) return errorResponse("The selected bill is no longer payable.",409);
        if (expectedPurpose !== actualPurpose) return errorResponse("The selected bill does not match the payment purpose.",409);
        if (bill.bill_type==='Rent' && (!includeLateFee || includeRent)) {
          const selectedMonth = isPartial ? item?.billing_month : rentBillingMonth;
          if (!selectedMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth) || bill.billing_month !== selectedMonth) return errorResponse("The selected Rent billing month has changed. Refresh and select the month again.",409);
        }
        if (bill.bill_type==='Security Deposit' && (!(Number(admission.security_deposit)>0) || !['Pending','Held'].includes(admission.deposit_status))) return errorResponse("The selected Deposit is not payable.",409);
        if (includeLateFee && !includeRent && bill.bill_type==='Rent') continue;
        const [paid,pending] = await Promise.all([
          supabaseAdmin.rpc('effective_bill_paid',{p_bill_id:bill.id}),
          supabaseAdmin.rpc('pending_bill_submissions',{p_bill:bill.id}),
        ]);
        if (paid.error || pending.error || paid.data===null || pending.data===null) return errorResponse("The selected balance could not be verified.",500);
        let outstanding = roundMoney(Number(bill.total_amount)-Number(paid.data));
        if (hasAdditional && bill.bill_type==='Rent') {
          const rent = await supabaseAdmin.rpc('outstanding_rent',{p_bill_id:bill.id});
          if (rent.error || rent.data===null) return errorResponse("The selected Rent balance could not be verified.",500);
          outstanding = Number(rent.data);
        }
        const available = roundMoney(outstanding-Number(pending.data));
        if (!(available>0) || (isPartial && Number(item?.amount)>available) || (!isPartial && Number(pending.data)>0)) return errorResponse("The selected bill is paid or its available balance changed. Review pending receipts.",409);
        selectedTotal = roundMoney(selectedTotal + available);
      }
      if (!isPartial && !includeLateFee && roundMoney(selectedTotal+(hasAdditional?Number(additionalAmount):0))!==amount) return errorResponse("The total must equal the exact selected obligations plus any declared Additional Charges.",409);
      selectedPurpose = allocatedPaymentLabel(selectedIds.map(bill_id=>({bill_id})),bills);
    }

    uploadedPath = historical
      ? `${resident.id}/historical/${crypto.randomUUID()}-${safeFileName(file.name)}`
      : `${resident.id}/combined/${admissionId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
    const { error: uploadError } = await supabaseAdmin.storage.from("payment-receipts").upload(uploadedPath, buffer, { contentType: file.type, cacheControl: "3600", upsert: false });
    if (uploadError) return errorResponse("The receipt file could not be uploaded. Please try again.", 500);
    if (historical) {
      const { error } = await supabaseAdmin.from("historical_payment_evidence").insert({
        resident_id:resident.id, purpose:String(formData.get("historicalPurpose") || ""),
        payment_date:String(formData.get("historicalDate") || ""), amount, payment_method:paymentMethod,
        reference_number:referenceNumber || null, description:notes, receipt_path:uploadedPath,
      });
      if(error) { await supabaseAdmin.storage.from("payment-receipts").remove([uploadedPath]); return errorResponse(error.message,409); }
      return NextResponse.json({message:"Historical evidence submitted. It does not pay any current bill or increase collections."},{headers:{"Cache-Control":"private, no-store"}});
    }
    const purpose = hasAdditional ? [rentBillId ? "Rent" : "", depositBillId ? "Security Deposit" : "", "Additional Charges"].filter(Boolean).join(" + ") : includeLateFee
      ? [includeRent ? "Rent" : "", depositBillId ? "Security Deposit" : "", "Late Fee"].filter(Boolean).join(" + ")
      : "Rent + Security Deposit";
    const receiptNotes = [`Payment method: ${paymentMethod}`, `Payment purpose: ${purpose}`, `Selected obligations: ${selectedPurpose}`, `Admission ID: ${admissionId}`, notes].filter(Boolean).join("\n");
    if (isPartial) {
      const { data, error } = await supabaseAdmin.rpc("submit_partial_obligations", {
        p_resident_id: resident.id, p_admission_id: admissionId,
        p_items: obligationItems.map(({bill_id,amount})=>({bill_id,amount})),
        p_due: String(formData.get("commitmentDate") || "") || null,
        p_reason: String(formData.get("commitmentReason") || "").trim().slice(0, 2000),
        p_ack: formData.get("acknowledged") === "true", p_payment_method: paymentMethod,
        p_reference_number: referenceNumber, p_notes: [`Payment method: ${paymentMethod}`, `Selected obligations: ${selectedPurpose}`, `Admission ID: ${admissionId}`, notes].filter(Boolean).join("\n"),
        p_receipt_url: uploadedPath, p_original_file_name: file.name.slice(0,255),
      });
      if (error || !data) {
        await supabaseAdmin.storage.from("payment-receipts").remove([uploadedPath]);
        return errorResponse(error?.message || "Submission failed.", 409);
      }
      return NextResponse.json({ message: "Payment pending staff verification; commitment has no financial effect.", ...data }, { headers: { "Cache-Control": "private, no-store" } });
    }
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
