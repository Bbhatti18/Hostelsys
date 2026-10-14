import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { calculateLateFee } from "@/lib/lateFee";

export type FineWaiverStatus = "Pending" | "Approved" | "Partially Approved" | "Rejected";

export type FineWaiverRequest = {
  id: string;
  bill_id: string;
  resident_id: string;
  bill_number?: string;
  billing_month?: string;
  due_date?: string;
  fine_amount: number;
  requested_amount: number;
  waived_amount: number;
  reason: string;
  status: FineWaiverStatus;
  admin_notes?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  created_at: string;
  updated_at: string;
  resident_name?: string;
  resident_email?: string;
  room_number?: string;
  bed_number?: string;
};

const WAIVER_SETTING_PREFIX = "fine_waiver_req:";

async function isTableAvailable(tableName: string): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.from(tableName).select("id").limit(1);
    if (error && error.code === "PGRST205") return false;
    return !error;
  } catch {
    return false;
  }
}

/**
 * Fetch all waiver requests for a specific resident.
 */
export async function getResidentWaiverRequests(residentId: string): Promise<FineWaiverRequest[]> {
  const tableExists = await isTableAvailable("fine_waiver_requests");

  let requests: FineWaiverRequest[] = [];

  if (tableExists) {
    const { data, error } = await supabaseAdmin
      .from("fine_waiver_requests")
      .select("*, bills(bill_number, billing_month, due_date)")
      .eq("resident_id", residentId)
      .order("created_at", { ascending: false });

    if (!error && Array.isArray(data)) {
      requests = data.map((row) => {
        const bill = Array.isArray(row.bills) ? row.bills[0] : row.bills;
        return {
          id: String(row.id),
          bill_id: String(row.bill_id),
          resident_id: String(row.resident_id),
          bill_number: bill?.bill_number ?? undefined,
          billing_month: bill?.billing_month ?? undefined,
          due_date: bill?.due_date ?? undefined,
          fine_amount: Number(row.fine_amount || 0),
          requested_amount: Number(row.requested_amount || 0),
          waived_amount: Number(row.waived_amount || 0),
          reason: String(row.reason || ""),
          status: row.status as FineWaiverStatus,
          admin_notes: row.admin_notes ?? null,
          reviewed_by: row.reviewed_by ?? null,
          reviewed_at: row.reviewed_at ?? null,
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
        };
      });
    }
  } else {
    // Fallback storage in system_settings
    const { data } = await supabaseAdmin
      .from("system_settings")
      .select("setting_key, notes")
      .like("setting_key", `${WAIVER_SETTING_PREFIX}%`);

    if (Array.isArray(data)) {
      for (const row of data) {
        try {
          if (!row.notes) continue;
          const parsed = JSON.parse(row.notes) as FineWaiverRequest;
          if (parsed.resident_id === residentId) {
            requests.push(parsed);
          }
        } catch {
          // ignore invalid json
        }
      }
    }
    requests.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  // Enrich with bill details if missing
  if (requests.some((r) => !r.bill_number)) {
    const billIds = Array.from(new Set(requests.map((r) => r.bill_id)));
    if (billIds.length > 0) {
      const { data: bills } = await supabaseAdmin
        .from("bills")
        .select("id, bill_number, billing_month, due_date")
        .in("id", billIds);

      const billMap = new Map((bills ?? []).map((b) => [String(b.id), b]));
      for (const req of requests) {
        const bill = billMap.get(req.bill_id);
        if (bill) {
          req.bill_number = bill.bill_number;
          req.billing_month = bill.billing_month;
          req.due_date = bill.due_date;
        }
      }
    }
  }

  return requests;
}

/**
 * Fetch all waiver requests for admin management.
 */
export async function getAllWaiverRequests(): Promise<FineWaiverRequest[]> {
  const tableExists = await isTableAvailable("fine_waiver_requests");
  let requests: FineWaiverRequest[] = [];

  if (tableExists) {
    const { data, error } = await supabaseAdmin
      .from("fine_waiver_requests")
      .select("*, bills(bill_number, billing_month, due_date), residents(full_name, email)")
      .order("created_at", { ascending: false });

    if (!error && Array.isArray(data)) {
      requests = data.map((row) => {
        const bill = Array.isArray(row.bills) ? row.bills[0] : row.bills;
        const resident = Array.isArray(row.residents) ? row.residents[0] : row.residents;
        return {
          id: String(row.id),
          bill_id: String(row.bill_id),
          resident_id: String(row.resident_id),
          bill_number: bill?.bill_number ?? undefined,
          billing_month: bill?.billing_month ?? undefined,
          due_date: bill?.due_date ?? undefined,
          fine_amount: Number(row.fine_amount || 0),
          requested_amount: Number(row.requested_amount || 0),
          waived_amount: Number(row.waived_amount || 0),
          reason: String(row.reason || ""),
          status: row.status as FineWaiverStatus,
          admin_notes: row.admin_notes ?? null,
          reviewed_by: row.reviewed_by ?? null,
          reviewed_at: row.reviewed_at ?? null,
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
          resident_name: resident?.full_name ?? undefined,
          resident_email: resident?.email ?? undefined,
        };
      });
    }
  } else {
    const { data } = await supabaseAdmin
      .from("system_settings")
      .select("setting_key, notes")
      .like("setting_key", `${WAIVER_SETTING_PREFIX}%`);

    if (Array.isArray(data)) {
      for (const row of data) {
        try {
          if (!row.notes) continue;
          const parsed = JSON.parse(row.notes) as FineWaiverRequest;
          requests.push(parsed);
        } catch {
          // ignore
        }
      }
    }
    requests.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  // Enrich with bill & resident & room details if missing
  const missingBills = requests.filter((r) => !r.bill_number);
  if (missingBills.length > 0) {
    const billIds = Array.from(new Set(missingBills.map((r) => r.bill_id)));
    const { data: bills } = await supabaseAdmin
      .from("bills")
      .select("id, bill_number, billing_month, due_date")
      .in("id", billIds);
    const map = new Map((bills ?? []).map((b) => [String(b.id), b]));
    for (const r of requests) {
      const b = map.get(r.bill_id);
      if (b) {
        r.bill_number = b.bill_number;
        r.billing_month = b.billing_month;
        r.due_date = b.due_date;
      }
    }
  }

  const missingResidents = requests.filter((r) => !r.resident_name);
  if (missingResidents.length > 0) {
    const residentIds = Array.from(new Set(missingResidents.map((r) => r.resident_id)));
    const { data: resList } = await supabaseAdmin
      .from("residents")
      .select("id, full_name, email")
      .in("id", residentIds);
    const map = new Map((resList ?? []).map((r) => [String(r.id), r]));
    for (const r of requests) {
      const res = map.get(r.resident_id);
      if (res) {
        r.resident_name = res.full_name;
        r.resident_email = res.email;
      }
    }
  }

  // Also fetch room and bed info
  const residentIds = Array.from(new Set(requests.map((r) => r.resident_id)));
  if (residentIds.length > 0) {
    const { data: admissions } = await supabaseAdmin
      .from("admissions")
      .select("resident_id, room_id, bed_id, rooms(room_number), beds(bed_number)")
      .in("resident_id", residentIds)
      .in("status", ["Pending", "Active"]);

    const admMap = new Map();
    for (const adm of admissions ?? []) {
      const room = Array.isArray(adm.rooms) ? adm.rooms[0] : adm.rooms;
      const bed = Array.isArray(adm.beds) ? adm.beds[0] : adm.beds;
      admMap.set(String(adm.resident_id), {
        room_number: room?.room_number,
        bed_number: bed?.bed_number,
      });
    }

    for (const r of requests) {
      const adm = admMap.get(r.resident_id);
      if (adm) {
        r.room_number = adm.room_number;
        r.bed_number = adm.bed_number;
      }
    }
  }

  return requests;
}

/**
 * Resident creates a new waiver request.
 */
export async function createWaiverRequest(params: {
  residentId: string;
  billId: string;
  fineAmount: number;
  requestedAmount: number;
  reason: string;
}): Promise<{ data: FineWaiverRequest | null; error: string | null }> {
  const { residentId, billId, fineAmount, requestedAmount, reason } = params;

  if (!reason || !reason.trim()) {
    return { data: null, error: "Please provide a valid reason for the waiver request." };
  }

  if (fineAmount <= 0) {
    return { data: null, error: "There is no fine on this bill to waive." };
  }

  const cleanRequestedAmount = Math.max(0, Math.min(fineAmount, requestedAmount || fineAmount));

  // Check if there is already a Pending request for this bill
  const existing = await getResidentWaiverRequests(residentId);
  const pending = existing.find((r) => r.bill_id === billId && r.status === "Pending");
  if (pending) {
    return { data: null, error: "You already have a pending waiver request for this bill." };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const newRequest: FineWaiverRequest = {
    id,
    bill_id: billId,
    resident_id: residentId,
    fine_amount: fineAmount,
    requested_amount: cleanRequestedAmount,
    waived_amount: 0,
    reason: reason.trim(),
    status: "Pending",
    created_at: now,
    updated_at: now,
  };

  const tableExists = await isTableAvailable("fine_waiver_requests");
  if (tableExists) {
    const { error } = await supabaseAdmin.from("fine_waiver_requests").insert({
      id: newRequest.id,
      bill_id: newRequest.bill_id,
      resident_id: newRequest.resident_id,
      fine_amount: newRequest.fine_amount,
      requested_amount: newRequest.requested_amount,
      waived_amount: 0,
      reason: newRequest.reason,
      status: "Pending",
      created_at: now,
      updated_at: now,
    });

    if (error) {
      return { data: null, error: "Failed to submit waiver request: " + error.message };
    }
  } else {
    // Save to system_settings fallback
    const { error } = await supabaseAdmin.from("system_settings").upsert({
      setting_key: `${WAIVER_SETTING_PREFIX}${id}`,
      notes: JSON.stringify(newRequest),
      updated_at: now,
    });

    if (error) {
      return { data: null, error: "Failed to submit waiver request: " + error.message };
    }
  }

  return { data: newRequest, error: null };
}

/**
 * Admin reviews a waiver request (Full Waiver, Partial Waiver, or Reject).
 */
export async function reviewWaiverRequest(params: {
  requestId: string;
  action: "FULL_WAIVER" | "PARTIAL_WAIVER" | "REJECT";
  waivedAmount?: number;
  adminNotes?: string;
  reviewerEmail: string;
}): Promise<{ data: FineWaiverRequest | null; error: string | null }> {
  const { requestId, action, adminNotes, reviewerEmail } = params;

  // Retrieve current request
  const allRequests = await getAllWaiverRequests();
  const target = allRequests.find((r) => r.id === requestId);

  if (!target) {
    return { data: null, error: "Waiver request not found." };
  }

  let newStatus: FineWaiverStatus;
  let finalWaivedAmount = 0;

  if (action === "FULL_WAIVER") {
    newStatus = "Approved";
    finalWaivedAmount = target.fine_amount;
  } else if (action === "PARTIAL_WAIVER") {
    const specified = Number(params.waivedAmount);
    if (!Number.isFinite(specified) || specified <= 0) {
      return { data: null, error: "Please enter a valid partial waiver amount greater than 0." };
    }
    if (specified > target.fine_amount) {
      return {
        data: null,
        error: `Partial waiver cannot exceed the total fine of Rs. ${target.fine_amount}.`,
      };
    }
    newStatus = "Partially Approved";
    finalWaivedAmount = Math.round(specified * 100) / 100;
  } else if (action === "REJECT") {
    newStatus = "Rejected";
    finalWaivedAmount = 0;
  } else {
    return { data: null, error: "Invalid action specified." };
  }

  const now = new Date().toISOString();
  target.status = newStatus;
  target.waived_amount = finalWaivedAmount;
  target.admin_notes = adminNotes?.trim() || null;
  target.reviewed_by = reviewerEmail;
  target.reviewed_at = now;
  target.updated_at = now;

  // 1. Update waiver request in DB
  const tableExists = await isTableAvailable("fine_waiver_requests");
  if (tableExists) {
    const { error: updateErr } = await supabaseAdmin
      .from("fine_waiver_requests")
      .update({
        status: newStatus,
        waived_amount: finalWaivedAmount,
        admin_notes: target.admin_notes,
        reviewed_by: reviewerEmail,
        reviewed_at: now,
        updated_at: now,
      })
      .eq("id", requestId);

    if (updateErr) {
      return { data: null, error: "Failed to update waiver request: " + updateErr.message };
    }
  } else {
    const { error: upsertErr } = await supabaseAdmin.from("system_settings").upsert({
      setting_key: `${WAIVER_SETTING_PREFIX}${requestId}`,
      notes: JSON.stringify(target),
      updated_at: now,
    });
    if (upsertErr) {
      return { data: null, error: "Failed to update waiver request: " + upsertErr.message };
    }
  }

  // 2. Synchronize with `late_fees` and `late_fee_history`
  if (newStatus === "Approved" || newStatus === "Partially Approved") {
    try {
      // Check existing late_fees row for this bill
      const { data: lateFeeRow } = await supabaseAdmin
        .from("late_fees")
        .select("*")
        .eq("bill_id", target.bill_id)
        .maybeSingle();

      const calculatedAmount = target.fine_amount;
      const feeStatus =
        finalWaivedAmount >= calculatedAmount ? "Waived" : "Partially Waived";

      if (lateFeeRow) {
        await supabaseAdmin
          .from("late_fees")
          .update({
            waived_amount: finalWaivedAmount,
            status: feeStatus,
            updated_at: now,
          })
          .eq("id", lateFeeRow.id);

        // Record audit in late_fee_history
        await supabaseAdmin.from("late_fee_history").insert({
          late_fee_id: lateFeeRow.id,
          action: feeStatus,
          amount_before: Number(lateFeeRow.payable_amount || 0),
          amount_after: Math.max(0, calculatedAmount - finalWaivedAmount - Number(lateFeeRow.paid_amount || 0)),
          waived_amount: finalWaivedAmount,
          reason: target.admin_notes || `Fine waiver request: ${newStatus}`,
          actor: reviewerEmail,
        });
      } else {
        // Insert new late_fees row
        const { data: newLateFee } = await supabaseAdmin
          .from("late_fees")
          .insert({
            bill_id: target.bill_id,
            calculated_amount: calculatedAmount,
            waived_amount: finalWaivedAmount,
            status: feeStatus,
            updated_at: now,
          })
          .select("id")
          .single();

        if (newLateFee) {
          await supabaseAdmin.from("late_fee_history").insert({
            late_fee_id: newLateFee.id,
            action: feeStatus,
            amount_before: calculatedAmount,
            amount_after: Math.max(0, calculatedAmount - finalWaivedAmount),
            waived_amount: finalWaivedAmount,
            reason: target.admin_notes || `Fine waiver request: ${newStatus}`,
            actor: reviewerEmail,
          });
        }
      }
    } catch (ledgerError) {
      console.warn("Ledger synchronization note:", ledgerError);
    }
  }

  return { data: target, error: null };
}
