import { normalizeIdentityEmail } from "@/lib/identity";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUnapprovedBill } from "@/lib/billApproval";

const CURRENT_ADMISSION_STATUSES = new Set(["Pending", "Active"]);
const CURRENT_CONTRACT_STATUSES = new Set([
  "Draft",
  "Pending Signature",
  "Active",
]);

function bearerToken(request: NextRequest) {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
}

function jsonError(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function GET(request: NextRequest) {
  try {
    const token = bearerToken(request);
    if (!token) return jsonError("Please sign in to access the resident portal.", 401);

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return jsonError("Resident portal server configuration is incomplete.", 500);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } =
      await authClient.auth.getUser(token);
    const user = authData.user;
    const email = user?.email?.trim().toLowerCase() ?? "";

    if (authError || !user || !email) {
      return jsonError("Please sign in to access the resident portal.", 401);
    }

    const metadataResidentId =
      typeof user.user_metadata?.resident_id === "string"
        ? user.user_metadata.resident_id.trim()
        : "";

    let resident = null;
    if (metadataResidentId) {
      const { data: resById } = await supabaseAdmin
        .from("residents")
        .select("id, email, full_name, status, phone, cnic, permanent_address")
        .eq("id", metadataResidentId)
        .maybeSingle();
      if (resById) {
        resident = resById;
      }
    }

    if (!resident) {
      const { data: resByEmail, error: residentError } = await supabaseAdmin
        .from("residents")
        .select("id, email, full_name, status, phone, cnic, permanent_address")
        .eq("email", normalizeIdentityEmail(email))
        .maybeSingle();

      if (residentError) {
        return jsonError("Your resident profile could not be verified.", 500);
      }
      resident = resByEmail;
    }
    if (!resident) {
      return jsonError("No resident profile is linked to this account.", 403);
    }
    if (String(resident.status ?? "").trim().toLowerCase() === "archived") {
      return jsonError("No active resident profile is linked to this account.", 403);
    }

    const residentId = resident.id;
    const { data: admissionRows, error: admissionError } = await supabaseAdmin
      .from("admissions")
      .select(
        "id, resident_id, room_id, bed_id, admission_date, expected_leaving_date, monthly_rent, security_deposit, deposit_status, status, created_at",
      )
      .eq("resident_id", residentId)
      .in("status", [...CURRENT_ADMISSION_STATUSES])
      .order("created_at", { ascending: false });

    if (admissionError) {
      return jsonError("Your current admission could not be loaded.", 500);
    }

    const admissions = admissionRows ?? [];
    if (admissions.length > 1) return jsonError("Multiple current admissions require staff review before displaying financial balances.", 409);
    const admission = admissions[0] ?? null;

    const [contractResult, billsResult, paymentsResult, receiptsResult, roomResult, bedResult] =
      await Promise.all([
        admission
          ? supabaseAdmin
              .from("contracts")
              .select(
                "id, contract_number, resident_id, admission_id, template_id, contract_content, start_date, end_date, monthly_rent, security_deposit, notice_period_days, status, resident_signature_url, resident_signature_status, owner_signature_status, signed_by_resident, signed_at, created_at",
              )
              .eq("resident_id", residentId)
              .eq("admission_id", admission.id)
              .order("created_at", { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        supabaseAdmin
          .from("bills")
          .select(
            "id, bill_number, resident_id, admission_id, billing_month, due_date, rent_amount, electricity_amount, ac_amount, other_amount, discount_amount, total_amount, paid_amount, balance_amount, bill_status, notes, bill_type",
          )
          .eq("resident_id", residentId)
          .neq("bill_status", "Pending Approval")
          .order("billing_month", { ascending: false }),
        supabaseAdmin
          .from("payments")
          .select(
            "id, bill_id, resident_id, payment_number, payment_date, amount, payment_method, reference_number, payment_status, verified, verified_by, verified_at, notes, created_at, payment_allocations(payment_id, bill_id, amount)",
          )
          .eq("resident_id", residentId)
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("payment_receipts")
          .select("id, payment_id, bill_id, resident_id, amount, reference_number, status, verified_by, verified_at, notes, created_at, additional_charge")
          .eq("resident_id", residentId)
          .order("created_at", { ascending: false }),
        admission?.room_id
          ? supabaseAdmin
              .from("rooms")
              .select("id, room_number, room_type, status")
              .eq("id", admission.room_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        admission?.bed_id
          ? supabaseAdmin
              .from("beds")
              .select("id, bed_number, status")
              .eq("id", admission.bed_id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);

    const queryError =
      contractResult.error ||
      billsResult.error ||
      paymentsResult.error ||
      receiptsResult.error ||
      roomResult.error ||
      bedResult.error;
    if (queryError) {
      return jsonError("Your resident portal records could not be loaded.", 500);
    }

    const contract = (contractResult.data ?? []).find((row) =>
      CURRENT_CONTRACT_STATUSES.has(
        String(row.status || "Draft"),
      ),
    ) ?? null;

    // Bills awaiting admin approval are not released to the resident yet.
    const visibleBills = (billsResult.data ?? []).filter(
      (bill) => !isUnapprovedBill(bill.bill_status),
    );
    const visibleBillIds = new Set(visibleBills.map((bill) => String(bill.id)));
    const visiblePayments = (paymentsResult.data ?? []).filter(
      (payment) => !payment.bill_id || visibleBillIds.has(String(payment.bill_id)) || (payment.payment_allocations ?? []).some((allocation) => visibleBillIds.has(String(allocation.bill_id))),
    );
    const normalizedPayments = visiblePayments.map(
      ({ payment_allocations, ...payment }) => ({
        ...payment,
        allocations: (payment_allocations ?? [])
          .filter((allocation) => visibleBillIds.has(String(allocation.bill_id)))
          .map((allocation) => ({
            bill_id: allocation.bill_id,
            amount: Number(allocation.amount ?? 0),
          })),
      }),
    );

    const visibleReceipts = (receiptsResult.data ?? []).filter(
      (receipt) => !receipt.bill_id || visibleBillIds.has(String(receipt.bill_id)),
    );

    return NextResponse.json(
      {
        data: {
          resident,
          admission,
          contract,
          room: roomResult.data,
          bed: bedResult.data,
          bills: visibleBills,
          payments: normalizedPayments,
          receipts: visibleReceipts,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return jsonError("Your resident portal records could not be loaded.", 500);
  }
}
